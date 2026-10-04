/**
 * Generic-title corroboration (BRO-2764).
 *
 * Shows whose title is only common words ("The Story", "Love", "King") substring-
 * match large volumes of unrelated coverage (Toy Story 5, "A Ghost Story", book
 * reviews) during discovery. For those shows a candidate URL must carry a second
 * signal, venue OR a cast name OR a creative-team name (director/playwright),
 * before it becomes a candidate.
 *
 * "Generic" is computed, not listed: a token is common when it appears in the
 * titles of >= COMMON_TOKEN_MIN_TITLES distinct shows in shows.json; a title is
 * generic when every non-structural token is common. Pure functions; the shows
 * corpus is passed in (or lazily loaded once by getTokenDocFreq()).
 */
const fs = require('fs');
const path = require('path');

const COMMON_TOKEN_MIN_TITLES = 10;
// Structural words carry no identity, so they never make a title specific.
const STRUCTURAL = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'is', 'my', 'your']);
const VENUE_GENERIC = new Set(['theatre', 'theater', 'stage', 'house', 'hall', 'center', 'centre', 'company', 'broadway', 'london', 'new york', 'west end']);

const VENUE_WORDS = new Set(['theatre', 'theater', 'theatres', 'the', 'company', 'house', 'hall', 'centre', 'center']);

const _DISABLED = String(process.env.GENERIC_TITLE_CORROBORATION || '').toLowerCase() === 'off';

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']s\b/g, '') // possessive: "Wilson’s" must still match "Wilson"
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleTokens(title) {
  return norm(title).split(' ').filter(Boolean);
}

/** Map token -> number of distinct normalized show titles containing it. */
function buildTokenDocFreq(shows) {
  const seenTitles = new Set();
  const df = new Map();
  for (const s of shows || []) {
    const key = norm(s && s.title);
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);
    for (const tok of new Set(key.split(' '))) df.set(tok, (df.get(tok) || 0) + 1);
  }
  return df;
}

let _dfCache = null;
function getTokenDocFreq() {
  if (!_dfCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf8'));
      _dfCache = buildTokenDocFreq(Array.isArray(raw) ? raw : raw.shows);
    } catch (e) {
      console.warn(`[generic-title-matching] shows.json unreadable (${e.message}); gate inactive`);
      _dfCache = new Map();
    }
  }
  return _dfCache;
}

/** True when every non-structural token of the title is common across show titles. */
function isGenericTitle(title, df = getTokenDocFreq(), minTitles = COMMON_TOKEN_MIN_TITLES) {
  const content = titleTokens(title).filter(t => !STRUCTURAL.has(t));
  if (content.length === 0) return false;
  return content.every(t => (df.get(t) || 0) >= minTitles);
}

function hasPhrase(haystack, phrase) {
  return phrase.length > 0 && (` ${haystack} `).includes(` ${phrase} `);
}

function venueTerms(venue) {
  const out = new Set();
  for (const seg of String(venue || '').split(/[(),\-–/]/)) {
    const n = norm(seg).replace(/^the /, '').trim();
    if (n.length >= 5 && !VENUE_GENERIC.has(n)) out.add(n);
    // "Garrick Theatre" is reviewed as "at the Garrick": also accept the name sans generic words.
    const core = n.split(' ').filter(w => !VENUE_WORDS.has(w)).join(' ');
    if (core.length >= 5 && !VENUE_GENERIC.has(core)) out.add(core);
  }
  return [...out];
}

function personTerms(name) {
  const full = norm(name);
  if (!full) return [];
  const out = [full];
  const parts = full.split(' ');
  // Surname alone only when long enough to be distinctive.
  if (parts.length > 1 && parts[parts.length - 1].length >= 5) out.push(parts[parts.length - 1]);
  return out;
}

/**
 * @param {Object} show - {title, venue, cast:[{name}], creativeNames:[str] | creativeTeam:[{name}]}
 * @param {string} text - candidate title + snippet + url
 * @returns {{signal: 'venue'|'cast'|'creative'|null, term?: string}}
 */
function findCorroboration(show, text) {
  const hay = norm(text);
  for (const t of venueTerms(show.venue || show.theater)) if (hasPhrase(hay, t)) return { signal: 'venue', term: t };
  for (const c of show.cast || []) {
    for (const t of personTerms(c && (c.name || c))) if (hasPhrase(hay, t)) return { signal: 'cast', term: t };
  }
  const creative = show.creativeNames || (show.creativeTeam || []).map(c => c && (c.name || c));
  for (const c of creative || []) {
    for (const t of personTerms(c)) if (hasPhrase(hay, t)) return { signal: 'creative', term: t };
  }
  return { signal: null };
}

/**
 * Candidate-generation gate. ok:true for non-generic titles (no behavior change).
 * @returns {{ok: boolean, reason?: string, detail?: string, signal?: string}}
 */
function checkGenericTitleCandidate({ show, candidate, df }) {
  if (_DISABLED || !show || !candidate || !show.title) return { ok: true };
  if (!isGenericTitle(show.title, df || getTokenDocFreq())) return { ok: true };
  // Nothing to corroborate with (new/slug-only shows): accept the small
  // contamination risk rather than silently under-collect (cf. url-discovery's
  // canDisambiguateGenericTitle).
  const hasPeople = (show.cast || []).length > 0 || (show.creativeNames || show.creativeTeam || []).length > 0;
  if (!hasPeople) return { ok: true, signal: 'unverifiable' };
  const text = `${candidate.title || ''} ${candidate.snippet || ''} ${candidate.url || ''}`;
  const c = findCorroboration(show, text);
  if (c.signal) return { ok: true, signal: c.signal };
  return {
    ok: false,
    reason: 'generic-title-uncorroborated',
    detail: `"${show.title}" is a generic title; no venue/cast/creative corroboration in candidate`,
  };
}

function _resetCachesForTest(df = null) { _dfCache = df; }

module.exports = {
  COMMON_TOKEN_MIN_TITLES, buildTokenDocFreq, isGenericTitle, findCorroboration,
  checkGenericTitleCandidate, _resetCachesForTest,
};
