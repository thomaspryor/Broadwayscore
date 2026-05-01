/**
 * Pre-fetch SERP-result validator.
 *
 * Inspects {url, title, snippet} from a SERP candidate BEFORE we burn
 * fetch credits and downstream LLM-scoring on the page. Rejects candidates
 * that show positive evidence of being a wrong-production same-title result.
 *
 * Test cases that motivated this (2026-04-29):
 *   - Hamlet (off-broadway-2026 at BAM): SERP for "Hamlet" in the
 *     opening-night window can return Old Vic / RSC productions.
 *   - The Receptionist (off-broadway-2026 at Signature Center): same play
 *     has a Royal Court / regional history.
 *
 * Design history (2026-04-30 corpus probes, fixed within the same session):
 *
 *   v1 used single-word venue tokens ("belasco", "hudson", "harvey",
 *   "simon") and a regional-tour heuristic. Probe over 10k real reviews
 *   showed 2.13% false-rejection rate dominated by surname/place collisions
 *   ("David Belasco" the playwright, "Hudson Yards", "Neil Simon"), cross-
 *   market sibling cross-talk (London Christmas Carol's Old Vic triggering
 *   on Broadway Christmas Carol), and regional-tour mentions in legit
 *   transfer-history snippets.
 *
 *   v2 tightened to multi-word tokens, same-market-pool siblings only,
 *   transfer-aware cross-market, and dropped regional-tour. Probe at 0.46%.
 *   But: remaining sibling-venue rejections were dominated by *person-named
 *   venues* (Stephen Sondheim Theatre, Ethel Barrymore Theatre, John Golden
 *   Theatre) collidng with critic-prose references to those people as
 *   composers / actors / playwrights. Many Broadway theaters are named
 *   after people; the structural collision is unfixable by tokenization.
 *
 *   v3 (this file) drops sibling-venue entirely and gates cross-market on
 *   URL DOMAIN: a UK marker in a UK-domain SERP result is real signal; the
 *   same marker in a US-domain result (NYT/Vulture/Variety) is almost
 *   always a transfer-history reference in a legitimate review of the
 *   target. The transfer-aware exemption is kept as a backstop. Rollback:
 *   SERP_PREFETCH_VALIDATOR=off in env.
 *
 * Design rules:
 *   - Conservative: reject only on positive multi-signal evidence.
 *   - URL domain is the primary disambiguator for cross-market.
 *   - Pure function: cache shows.json, no I/O at call time.
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket, getMarketPool } = require('./venue-classification');

let _showsJsonCache = null;
let _siblingTitleIndex = null;

const _DISABLED = String(process.env.SERP_PREFETCH_VALIDATOR || '').toLowerCase() === 'off';

/**
 * UK-market venue / production-company markers. Reject when:
 *   - target market is NYC AND
 *   - candidate URL is on a UK domain AND
 *   - text contains any marker AND
 *   - shows.json has no same-title sibling in London (transfer-aware bypass).
 */
const UK_HARD_MARKERS = [
  'old vic',
  'donmar warehouse',
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
  'menier chocolate factory',
  'noel coward theatre',
  'noël coward theatre',
];

const US_HARD_MARKERS = [
  'lincoln center theater',
  'manhattan theatre club',
  'roundabout theatre',
  'second stage theater',
  'atlantic theater company',
  'signature theatre, new york',
  'new york theatre workshop',
];

/**
 * Domain markers used to gate cross-market rejection. A UK-marker mention on
 * an NYT URL is almost certainly transfer-history; on a Guardian URL it's a
 * London-production review. We only fire on URL-domain alignment.
 *
 * The lists are SUFFIX matches (`hostname.endsWith(suffix)`) so subdomains
 * resolve correctly (e.g., `arts.theguardian.com`).
 */
const UK_DOMAIN_SUFFIXES = [
  '.co.uk', '.uk',
  'thestage.co.uk', 'theguardian.com', 'standard.co.uk', 'thetimes.co.uk',
  'telegraph.co.uk', 'westendtheatre.com', 'whatsonstage.com',
  'theartsdesk.com', 'broadwayworld.com/uk', // BWW UK section
  'londontheatre.co.uk', 'londontheatre1.com',
];

const US_DOMAIN_SUFFIXES = [
  'nytimes.com', 'vulture.com', 'variety.com', 'hollywoodreporter.com',
  'theatermania.com', 'broadwayworld.com', 'newyorkstagereview.com',
  'newyorktheatreguide.com', 'theatrely.com', 'showscoremagazine.com',
  'wsj.com', 'washingtonpost.com', 'nymag.com', 'newyorker.com',
  'playbill.com', 'time.com', 'rollingstone.com', 'usatoday.com',
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
 * Normalize a title for cross-production matching.
 */
function _normalizeTitleForMatch(t) {
  if (!t) return '';
  return String(t)
    .toLowerCase()
    .replace(/^\s*(the|a|an)\s+/, '')
    .replace(/\s*[:\-–—].*$/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a one-shot index: normalizedTitle → Array<{showId, marketPool}>.
 * Used solely for the cross-market transfer-aware exemption (v3 dropped
 * sibling-venue check; venue tokens are no longer indexed).
 */
function _buildSiblingIndex() {
  if (_siblingTitleIndex) return _siblingTitleIndex;
  const data = _loadShowsJson();
  const shows = Array.isArray(data) ? data : (data.shows || []);
  const index = new Map();
  for (const s of shows) {
    const key = _normalizeTitleForMatch(s.title);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      showId: s.id,
      marketPool: getMarketPool(s.category),
    });
  }
  _siblingTitleIndex = index;
  return index;
}

/**
 * Test exposure only. Multi-word venue token extractor — currently unused
 * by the validator but kept exported for downstream tools that might want
 * to enumerate distinctive venue tokens.
 */
function _venueTokens(venueRaw) {
  const v = String(venueRaw || '').toLowerCase().trim();
  if (!v) return [];
  const tokens = new Set();
  const normalized = v
    .replace(/\bthe\b/g, '')
    .replace(/\btheatres?\b/g, '')
    .replace(/\btheaters?\b/g, '')
    .replace(/\bstage\b/g, '')
    .replace(/\bat\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length >= 4 && normalized.includes(' ')) tokens.add(normalized);
  const GENERIC = new Set([
    'theatre', 'theater', 'stage', 'house', 'hall', 'center', 'centre',
    'company', 'broadway', 'london', 'new', 'york', 'east', 'west', 'north',
    'south', 'club', 'square', 'street', 'avenue', 'road', 'royal',
  ]);
  const words = normalized.split(' ').filter(w => w.length >= 3);
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    const bothGeneric = GENERIC.has(words[i]) && GENERIC.has(words[i + 1]);
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

function _hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function _domainMatchesAnySuffix(host, suffixes) {
  if (!host) return false;
  for (const suffix of suffixes) {
    if (host === suffix || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`) || host.includes(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a single SERP candidate against a target show.
 *
 * @param {Object} args
 * @param {Object} args.show - Show object (or subset with id, title, category).
 * @param {Object} args.candidate - SERP result with {url, title, snippet}.
 * @returns {{ok: boolean, reason?: string, detail?: string, confidence?: 'high'|'medium'}}
 */
function validateSerpCandidate({ show, candidate }) {
  if (_DISABLED) {
    _recordResult(true, null);
    return { ok: true };
  }
  if (!show || !candidate) {
    _recordResult(true, null);
    return { ok: true };
  }
  const url = String(candidate.url || '');
  const urlLower = url.toLowerCase();
  const title = String(candidate.title || '').toLowerCase();
  const snippet = String(candidate.snippet || '').toLowerCase();
  const text = `${title} ${snippet} ${urlLower}`;

  if (!url) {
    _recordResult(true, null);
    return { ok: true };
  }

  // ---------- Cross-market hard markers (URL-domain gated) ----------
  // Reject only when the candidate URL is on a domain in the OPPOSITE market
  // and the text contains a hard marker. This prevents transfer-history
  // mentions in NYT/Vulture/Variety reviews from getting falsely rejected.
  // Transfer-aware: also exempt when shows.json has a same-title sibling in
  // the opposite market (Broadway run reviewing a West End-originated show).
  const titleKey = _normalizeTitleForMatch(show.title);
  const isLondon = isLondonMarket(show.category);
  const ownPool = isLondon ? 'london' : 'nyc';
  const oppositePool = ownPool === 'nyc' ? 'london' : 'nyc';
  const opposingMarkers = isLondon ? US_HARD_MARKERS : UK_HARD_MARKERS;
  const opposingDomainSuffixes = isLondon ? US_DOMAIN_SUFFIXES : UK_DOMAIN_SUFFIXES;

  let hasTransferSibling = false;
  if (titleKey) {
    const siblings = _buildSiblingIndex().get(titleKey) || [];
    hasTransferSibling = siblings.some(
      s => s.showId !== show.id && s.marketPool === oppositePool
    );
  }

  if (!hasTransferSibling) {
    const host = _hostFromUrl(url);
    const isOpposingDomain = _domainMatchesAnySuffix(host, opposingDomainSuffixes);
    if (isOpposingDomain) {
      for (const marker of opposingMarkers) {
        if (text.includes(marker)) {
          const result = {
            ok: false,
            reason: 'cross-market',
            detail: `target market is ${isLondon ? 'London' : 'NYC'}; URL on ${isLondon ? 'US' : 'UK'} domain "${host}"; text mentions "${marker.trim()}"`,
            confidence: 'high',
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

function _resetCachesForTest() {
  _showsJsonCache = null;
  _siblingTitleIndex = null;
}

module.exports = {
  validateSerpCandidate,
  getSerpValidatorStats,
  resetSerpValidatorStats,
  _resetCachesForTest,
  _normalizeTitleForMatch,
  _venueTokens,
  UK_HARD_MARKERS,
  US_HARD_MARKERS,
  UK_DOMAIN_SUFFIXES,
  US_DOMAIN_SUFFIXES,
};
