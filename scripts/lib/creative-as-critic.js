'use strict';

/**
 * Shared predicate: is this review's byline actually a CREDITED PERSON on the
 * same show (creative team or cast) rather than a critic?
 *
 * WHY THIS IS A SHARED LIB (CLAUDE.md §15): the detection already existed in
 * scripts/validate-data.js (CHECK 1 of validateReviewTextQuality), but it ran
 * at VALIDATION time — after ingest. So the BWW roundup extractor could re-write
 * a mis-parsed row, main would go red, an operator would delete the file, and
 * the next extraction would re-create it. That loop ran twice for
 * how-to-dance-in-ohio-2023 (critic "Sammi Cannold" — the show's DIRECTOR,
 * outletId an article headline, url/publishDate/fullText all null): deleted
 * 2026-08-01 (6aac25202f1) and again 2026-09-06 (edd0d124736), with the source
 * archive still holding the row both times. The predicate now lives here and is
 * required by BOTH the validator and the save-time chokepoint
 * (createOrMergeReviewFile in review-file-writer.js), so the two cannot drift —
 * the same shape as looksLikeUrlCriticName / sanitizeCriticName, which mirror
 * validate-data's [url-critic] gate into the writer.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO
 *
 * 1. It never matches GLOBALLY. Names are compared only against the credits of
 *    the SAME show. Critic "Scott Brown" and actor "Scott Brown" are different
 *    people, and a global index would flag the critic on every show the actor
 *    ever appeared in.
 *
 * 2. It ignores SENTINEL names on BOTH sides. Shows carry placeholder credits:
 *    la-ternura-off-broadway-2025's creativeTeam is literally
 *    [{name: "unknown", role: "Director"}], and unbylined reviews are written
 *    with criticName "Unknown". Matching those two would condemn an ordinary
 *    unbylined review as garbage. Filtering only the critic side, or only the
 *    show side, is not enough — a sentinel on EITHER side must lose.
 */

/**
 * Placeholder credit/byline values. A name in this set is a stand-in for
 * "we don't know", never a person, so it can never evidence a match.
 * Mirrors the PLACEHOLDER_NAMES set this predicate was extracted from.
 */
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'tba', 'tbd', 'tbc', 'n/a', 'na', 'anonymous',
]);

/** Cache of per-show name sets, keyed on the show object itself. */
const _setsCache = new WeakMap();

/** @param {*} name @returns {string} lowercased/trimmed, '' when unusable */
function normalizePersonName(name) {
  return typeof name === 'string' ? name.toLowerCase().trim() : '';
}

/**
 * True when a name is a placeholder rather than a person.
 * @param {*} name
 * @returns {boolean}
 */
function isSentinelPersonName(name) {
  const n = normalizePersonName(name);
  return n === '' || PLACEHOLDER_NAMES.has(n);
}

/**
 * Build the per-show credited-name sets, sentinels already removed.
 * @param {object|null} show - a shows.json record
 * @returns {{creative: Set<string>, cast: Set<string>}} lowercased names
 */
function buildShowPersonNameSets(show) {
  if (!show || typeof show !== 'object') return { creative: new Set(), cast: new Set() };
  const cached = _setsCache.get(show);
  if (cached) return cached;

  const creative = new Set();
  const cast = new Set();
  for (const member of Array.isArray(show.creativeTeam) ? show.creativeTeam : []) {
    const n = normalizePersonName(member && member.name);
    if (n && !PLACEHOLDER_NAMES.has(n)) creative.add(n);
  }
  for (const member of Array.isArray(show.cast) ? show.cast : []) {
    const raw = typeof member === 'string' ? member : (member && member.name);
    const n = normalizePersonName(raw);
    if (n && !PLACEHOLDER_NAMES.has(n)) cast.add(n);
  }

  const sets = { creative, cast };
  _setsCache.set(show, sets);
  return sets;
}

/**
 * Classify a byline against pre-built sets. Use this in hot loops (the
 * validator walks 42,000+ files) so the sets are built once per show.
 *
 * @param {{creative: Set<string>, cast: Set<string>}} sets
 * @param {string} criticName
 * @returns {{match: boolean, kind: 'creative'|'cast'|null, matchedName: string|null, reason: string}}
 */
function classifyCriticAgainstSets(sets, criticName) {
  if (arguments.length < 2) {
    // Deliberate. A predicate that silently returns "no match" when a caller
    // forgets an argument is INVISIBLE to every test that will ever be written
    // for it: a guard called with a missing argument fails its revert-check
    // exactly like a working one. Fail loudly at the call site instead.
    throw new TypeError('classifyCriticAgainstSets(sets, criticName) requires both arguments');
  }
  const miss = (reason) => ({ match: false, kind: null, matchedName: null, reason });
  if (!sets || !(sets.creative instanceof Set) || !(sets.cast instanceof Set)) {
    return miss('no-show-record');
  }
  if (isSentinelPersonName(criticName)) return miss('sentinel-critic');

  const n = normalizePersonName(criticName);
  if (sets.creative.has(n)) return { match: true, kind: 'creative', matchedName: n, reason: 'creative-team-member' };
  if (sets.cast.has(n)) return { match: true, kind: 'cast', matchedName: n, reason: 'cast-member' };
  return miss('no-match');
}

/**
 * Convenience for one-off call sites (the save-time writer handles one review
 * at a time). Both arguments are REQUIRED — see the throw in
 * classifyCriticAgainstSets for why.
 *
 * A null/absent `show` returns reason 'no-show-record', NOT a bare false, so a
 * caller that failed to resolve its show record is distinguishable from a
 * genuine non-match by both callers and tests.
 *
 * @param {object|null} show
 * @param {string} criticName
 * @returns {{match: boolean, kind: 'creative'|'cast'|null, matchedName: string|null, reason: string}}
 */
function evaluateCreditedPersonAsCritic(show, criticName) {
  if (arguments.length < 2) {
    throw new TypeError('evaluateCreditedPersonAsCritic(show, criticName) requires both arguments');
  }
  if (!show || typeof show !== 'object') {
    return { match: false, kind: null, matchedName: null, reason: 'no-show-record' };
  }
  return classifyCriticAgainstSets(buildShowPersonNameSets(show), criticName);
}

module.exports = {
  PLACEHOLDER_NAMES,
  normalizePersonName,
  isSentinelPersonName,
  buildShowPersonNameSets,
  classifyCriticAgainstSets,
  evaluateCreditedPersonAsCritic,
};
