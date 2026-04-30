/**
 * Pre-fetch SERP-result validator.
 *
 * Inspects {url, title, snippet} from a SERP candidate BEFORE we burn
 * fetch credits and downstream LLM-scoring on the page. Rejects candidates
 * that show positive evidence of being a wrong-production same-title result.
 *
 * Test cases that motivated this (2026-04-29):
 *   - Hamlet (off-broadway-2026 at BAM): SERP for "Hamlet" in the
 *     opening-night window can return Old Vic / RSC / sibling Broadway
 *     productions (Belasco 1995, Broadhurst 2009, Beaumont 1975).
 *   - The Receptionist (off-broadway-2026 at Signature Center): same
 *     play has played MTC and regional houses. Date filter is the
 *     primary defense; this validator is the second.
 *
 * Design rules:
 *   - Conservative rejection — only reject on POSITIVE evidence of a
 *     different production (sibling venue named, exclusive cross-market
 *     venue named). Missing-expected-venue is NOT a reason to reject:
 *     SERP snippets are too short to reliably mention the venue.
 *   - Pure function: cache shows.json read, do no I/O at call time.
 *   - Stats are exposed via getSerpValidatorStats() for instrumentation.
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./venue-classification');

let _showsJsonCache = null;
let _siblingVenueIndex = null;
let _siblingCastIndex = null;

/**
 * UK-market venue / production-company markers. If a Broadway / Off-Broadway
 * candidate's text contains any of these, it's almost certainly a different
 * production. Each is specific enough that incidental mention in a
 * Broadway-show review is rare.
 *
 * Lowercase substring match against `${title} ${snippet} ${url}`.
 */
const UK_HARD_MARKERS = [
  'old vic',
  'donmar',
  'royal shakespeare',
  ' rsc ',
  '/rsc/',
  'rsc.org.uk',
  "shakespeare's globe",
  'stratford-upon-avon',
  'stratford upon avon',
  'almeida theatre',
  'theatre royal haymarket',
  'theatre royal drury lane',
  'royal court theatre',
  'national theatre, london',
  'national theatre london',
  'sadler’s wells',
  "sadler's wells",
  'bridge theatre',
  'soho theatre',
  'menier chocolate factory',
  'noel coward theatre',
  'noël coward theatre',
];

/**
 * US-market venue markers used in reverse: a West End candidate that mentions
 * these is likely the wrong production.
 */
const US_HARD_MARKERS = [
  'lincoln center theater',
  'manhattan theatre club',
  'public theater',
  'roundabout theatre',
  'second stage theater',
  'atlantic theater company',
  'mcc theater',
  'signature theatre, new york',
  'new york theatre workshop',
  'broadway theatre, new york',
];

/**
 * Tokens that indicate a non-NYC, non-London regional production. Used as
 * supporting evidence (not solo-reject).
 */
const REGIONAL_TOUR_MARKERS = [
  'national tour',
  'touring production',
  'in chicago',
  'in los angeles',
  'in san francisco',
  'in boston',
  'in washington',
  'kennedy center',
  'goodman theatre',
  'oregon shakespeare',
  'huntington theatre',
];

function _loadShowsJson() {
  if (_showsJsonCache) return _showsJsonCache;
  try {
    const p = path.join(process.cwd(), 'data/shows.json');
    _showsJsonCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    _showsJsonCache = { shows: [] };
  }
  return _showsJsonCache;
}

/**
 * Normalize a title for cross-production matching. Strips articles, punctuation,
 * subtitles after `:` or ` - `, and collapses whitespace.
 */
function _normalizeTitleForMatch(t) {
  if (!t) return '';
  return String(t)
    .toLowerCase()
    .replace(/^\s*(the|a|an)\s+/, '')
    .replace(/\s*[:\-–—].*$/, '') // strip subtitle after colon or em/en dash
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a one-shot index of {normalizedTitle -> Array<{showId, venueTokens, castTokens}>}.
 * Used to find sibling productions of the same title and pull their venue tokens.
 */
function _buildSiblingIndex() {
  if (_siblingVenueIndex && _siblingCastIndex) {
    return { venueIndex: _siblingVenueIndex, castIndex: _siblingCastIndex };
  }
  const data = _loadShowsJson();
  const shows = Array.isArray(data) ? data : (data.shows || []);
  const venueIndex = new Map();
  const castIndex = new Map();
  for (const s of shows) {
    const key = _normalizeTitleForMatch(s.title);
    if (!key) continue;
    if (!venueIndex.has(key)) venueIndex.set(key, []);
    if (!castIndex.has(key)) castIndex.set(key, []);
    const venueTokens = [];
    const venue = s.venue || s.theater;
    if (venue) {
      const tokens = _venueTokens(venue);
      venueTokens.push(...tokens);
    }
    venueIndex.get(key).push({ showId: s.id, venueTokens });
    const castNames = Array.isArray(s.cast)
      ? s.cast.slice(0, 3).map(c => (c && c.name ? c.name.toLowerCase() : '')).filter(Boolean)
      : [];
    castIndex.get(key).push({ showId: s.id, castNames });
  }
  _siblingVenueIndex = venueIndex;
  _siblingCastIndex = castIndex;
  return { venueIndex, castIndex };
}

/**
 * Extract searchable tokens from a venue name. Drops generic words ("theatre",
 * "theater", "stage", "the", "at") so we match on the distinctive part.
 *   "BAM Harvey Theater"                 → ["bam harvey", "bam", "harvey"]
 *   "The Belasco Theatre"                → ["belasco"]
 *   "The Irene Diamond Stage at the Pershing Square Signature Center"
 *                                        → ["irene diamond", "pershing square signature", "signature center"]
 */
function _venueTokens(venueRaw) {
  const v = String(venueRaw || '').toLowerCase().trim();
  if (!v) return [];
  const tokens = new Set();
  // Full normalized
  const normalized = v
    .replace(/\bthe\b/g, '')
    .replace(/\btheatres?\b/g, '')
    .replace(/\btheaters?\b/g, '')
    .replace(/\bstage\b/g, '')
    .replace(/\bat\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length >= 4) tokens.add(normalized);
  // Distinctive single words (>=5 chars, not generic)
  const GENERIC = new Set([
    'theatre', 'theater', 'stage', 'house', 'hall', 'center', 'centre',
    'company', 'broadway', 'london', 'new', 'york', 'east', 'west', 'north',
    'south', 'club', 'square', 'street', 'avenue', 'road', 'royal'
  ]);
  for (const word of normalized.split(' ')) {
    if (word.length >= 5 && !GENERIC.has(word)) tokens.add(word);
  }
  // Distinctive two-word substrings (skipping generic-only pairs)
  const words = normalized.split(' ').filter(w => w.length >= 3);
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i+1]}`;
    const bothGeneric = GENERIC.has(words[i]) && GENERIC.has(words[i+1]);
    if (!bothGeneric && pair.length >= 8) tokens.add(pair);
  }
  return [...tokens];
}

const _stats = {
  total: 0,
  ok: 0,
  rejected: 0,
  byReason: Object.create(null),
};

function _recordResult(ok, reason) {
  _stats.total++;
  if (ok) _stats.ok++;
  else {
    _stats.rejected++;
    if (reason) _stats.byReason[reason] = (_stats.byReason[reason] || 0) + 1;
  }
}

/**
 * Validate a single SERP candidate against a target show.
 *
 * @param {Object} args
 * @param {Object} args.show - Show object from shows.json (or a subset with
 *     id, title, category, venue, cast).
 * @param {Object} args.candidate - SERP result with {url, title, snippet}.
 * @returns {{ok: boolean, reason?: string, detail?: string, confidence?: 'high'|'medium'}}
 */
function validateSerpCandidate({ show, candidate }) {
  if (!show || !candidate) {
    _recordResult(true, null);
    return { ok: true };
  }
  const url = String(candidate.url || '').toLowerCase();
  const title = String(candidate.title || '').toLowerCase();
  const snippet = String(candidate.snippet || '').toLowerCase();
  const text = `${title} ${snippet} ${url}`;

  if (!url) {
    _recordResult(true, null);
    return { ok: true };
  }

  // ---------- Check 1: sibling-production venue mention ----------
  // If another show in shows.json has the same title and its distinctive
  // venue tokens appear in the candidate text, this is a sibling production
  // (revival, prior run) — unless the target show's OWN venue is also
  // mentioned (in which case we have ambiguous text).
  const titleKey = _normalizeTitleForMatch(show.title);
  if (titleKey) {
    const { venueIndex } = _buildSiblingIndex();
    const siblings = venueIndex.get(titleKey) || [];
    const ownVenue = show.venue || show.theater;
    const ownTokens = ownVenue ? _venueTokens(ownVenue) : [];
    const ownVenueMentioned = ownTokens.some(t => t && text.includes(t));

    for (const sib of siblings) {
      if (sib.showId === show.id) continue;
      for (const tok of sib.venueTokens) {
        if (!tok || tok.length < 4) continue;
        // Don't reject on tokens that are also tokens of the target's venue
        // (e.g., shared "harvey" between BAM Harvey and Harvey Pekar).
        if (ownTokens.includes(tok)) continue;
        if (text.includes(tok)) {
          // If target's own venue is also explicitly mentioned, treat as
          // ambiguous (could be a comparison piece) and accept.
          if (ownVenueMentioned) break;
          const result = {
            ok: false,
            reason: 'sibling-venue',
            detail: `mentions sibling production venue "${tok}" (${sib.showId}); target venue not mentioned`,
            confidence: 'high',
          };
          _recordResult(false, result.reason);
          return result;
        }
      }
    }
  }

  // ---------- Check 2: cross-market hard markers ----------
  const isLondon = isLondonMarket(show.category);
  const opposingMarkers = isLondon ? US_HARD_MARKERS : UK_HARD_MARKERS;
  for (const marker of opposingMarkers) {
    if (text.includes(marker)) {
      const result = {
        ok: false,
        reason: 'cross-market',
        detail: `target market is ${isLondon ? 'London' : 'NYC'}; candidate mentions "${marker.trim()}"`,
        confidence: 'high',
      };
      _recordResult(false, result.reason);
      return result;
    }
  }

  // ---------- Check 3: known regional/tour markers (medium confidence) ----------
  // Only reject when paired with the show title — if a snippet says
  // "national tour" without naming this show, that's likely a different
  // article entirely. Conservative: require "national tour" / "touring" AND
  // the show title to co-occur.
  const titleNormalized = _normalizeTitleForMatch(show.title);
  if (titleNormalized && titleNormalized.length >= 3) {
    const titleInText = text.includes(titleNormalized);
    if (titleInText) {
      for (const marker of REGIONAL_TOUR_MARKERS) {
        if (text.includes(marker)) {
          // For Broadway/OB shows: if the show's own venue is also mentioned,
          // it's probably a "before Broadway, this had a tour" recap, not a
          // wrong-production result. Accept.
          const ownVenue = show.venue || show.theater;
          const ownTokens = ownVenue ? _venueTokens(ownVenue) : [];
          const ownVenueMentioned = ownTokens.some(t => t && text.includes(t));
          if (ownVenueMentioned) break;
          const result = {
            ok: false,
            reason: 'regional-tour',
            detail: `candidate mentions "${marker}" with title; target venue not mentioned`,
            confidence: 'medium',
          };
          _recordResult(false, result.reason);
          return result;
        }
      }
    }
  }

  _recordResult(true, null);
  return { ok: true };
}

/**
 * Return a snapshot of validator stats for instrumentation. Resets on
 * resetSerpValidatorStats().
 */
function getSerpValidatorStats() {
  return {
    total: _stats.total,
    ok: _stats.ok,
    rejected: _stats.rejected,
    byReason: { ..._stats.byReason },
  };
}

function resetSerpValidatorStats() {
  _stats.total = 0;
  _stats.ok = 0;
  _stats.rejected = 0;
  _stats.byReason = Object.create(null);
}

/**
 * Test seam: clear cached shows.json + sibling indexes so a test that
 * mutates `data/shows.json` between cases sees the new state.
 */
function _resetCachesForTest() {
  _showsJsonCache = null;
  _siblingVenueIndex = null;
  _siblingCastIndex = null;
}

module.exports = {
  validateSerpCandidate,
  getSerpValidatorStats,
  resetSerpValidatorStats,
  _resetCachesForTest,
  // Exported for unit tests
  _normalizeTitleForMatch,
  _venueTokens,
  UK_HARD_MARKERS,
  US_HARD_MARKERS,
  REGIONAL_TOUR_MARKERS,
};
