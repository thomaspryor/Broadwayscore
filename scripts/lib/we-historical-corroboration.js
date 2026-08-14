'use strict';

/**
 * WE historical season discovery: independent-source corroboration predicate
 * (plan v2.2 S1).
 *
 * Theatre Record is the primary discovery source (its production index is
 * comprehensive and cheap to query), but TR-discovers + TR-validates is
 * circular — a bad TR entry would rubber-stamp itself. The *validation* pair
 * must be independent of TR: Wikipedia season lists, Olivier eligibility
 * lists, and OLT (Off-Loop Theatre / similar independent listings) are the
 * candidate corroboration sources. A candidate is promotable only when at
 * least 2 of those independent sources agree with it on title + venue +
 * opening window.
 *
 * "Agree" tolerates realistic source disagreement: title normalization
 * (accents, subtitle punctuation) via title-match.js, venue canonicalization
 * (same helper), and an opening-date window (default ±14 days — sources
 * often report the first preview vs. press night vs. general opening as
 * "the" date).
 */

const { normalizeTitle } = require('./title-match');
const { venuesMatch } = require('./deduplication');

// Theatre Record is the discovery source, not a validation source — a
// candidate agreeing with itself proves nothing. Any name variant used to
// tag TR-sourced records must be listed here.
const DISCOVERY_ONLY_SOURCES = new Set(['theatre-record', 'tr']);

const DEFAULT_DAY_TOLERANCE = 14;
const DEFAULT_MIN_INDEPENDENT_SOURCES = 2;

/**
 * @param {{title: string, venue: string, openingDate?: string|null}} a
 * @param {{title: string, venue: string, openingDate?: string|null}} b
 * @param {{dayTolerance?: number}} [opts]
 * @returns {boolean}
 */
function recordsAgree(a, b, opts = {}) {
  if (!a || !b || !a.title || !b.title || !a.venue || !b.venue) return false;
  const dayTolerance = opts.dayTolerance ?? DEFAULT_DAY_TOLERANCE;

  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  // venuesMatch(), not title-match.js's canonicalVenue() — that function's
  // fallback for a venue outside VENUE_ALIASES is just the lowercased FIRST
  // WORD, so two unrelated venues sharing a leading word ("The X") would
  // falsely corroborate each other here — the one thing standing between a
  // real independent-source agreement and a rubber-stamped bad candidate
  // (BRO-243).
  if (!venuesMatch(a.venue, b.venue)) return false;

  // Fail closed on a missing date rather than skipping the window check —
  // West End venues restage the same title+venue combo years or decades
  // apart (Cats, Chess, pantomimes), so title+venue alone is not enough to
  // call two records the same production when neither confirms the year.
  if (!a.openingDate || !b.openingDate) return false;
  const da = new Date(a.openingDate);
  const db = new Date(b.openingDate);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return false;
  const diffDays = Math.abs(da - db) / 86400000;
  if (diffDays > dayTolerance) return false;

  return true;
}

/**
 * Decide whether a discovery candidate is corroborated by enough independent
 * sources to be promotable.
 *
 * @param {{title: string, venue: string, openingDate?: string|null, discoverySource?: string}} candidate
 * @param {Array<{source: string, title: string, venue: string, openingDate?: string|null}>} sourceRecords
 *   Independent validation records (e.g. one per Wikipedia season-list row,
 *   one per Olivier eligibility entry). Records tagged with a
 *   DISCOVERY_ONLY_SOURCES name are ignored even if passed in.
 * @param {{dayTolerance?: number, minIndependentSources?: number}} [opts]
 * @returns {{corroborated: boolean, agreeingSources: string[], matches: Array}}
 */
function isCorroborated(candidate, sourceRecords, opts = {}) {
  const minIndependentSources = opts.minIndependentSources ?? DEFAULT_MIN_INDEPENDENT_SOURCES;
  const records = Array.isArray(sourceRecords) ? sourceRecords : [];

  const independent = records.filter(r => r && !DISCOVERY_ONLY_SOURCES.has(String(r.source || '').toLowerCase()));
  const matches = independent.filter(r => recordsAgree(candidate, r, opts));

  // A source can list the same production more than once (e.g. two Wikipedia
  // sections); count DISTINCT source names toward the threshold, not rows.
  const agreeingSources = [...new Set(matches.map(m => m.source))];

  return {
    corroborated: agreeingSources.length >= minIndependentSources,
    agreeingSources,
    matches,
  };
}

module.exports = {
  DISCOVERY_ONLY_SOURCES,
  recordsAgree,
  isCorroborated,
};
