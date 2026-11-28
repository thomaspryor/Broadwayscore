'use strict';
/**
 * BRO-8455 item 1: a URL-less review file whose only source is an NYC Theatre / NYSR roundup excerpt is
 * about a New York production. On a city-hub regional row or a tour row it is the Broadway/Off-Broadway run
 * of the same title (purpose-regional-2026 carried the 2025 Broadway run's TheaterMania, NY Post and Broadway
 * News excerpts; the-cottage-regional-2026 the 2023 run's). scrape-nyc-theatre-roundups.js already skips
 * regional shows (BRO-7453); this is the rebuild-side guard for files that landed before it or by another route.
 * Pure; no I/O.
 */
const ROUNDUP_SOURCES = new Set(['nyc-theatre', 'nyc-theatre-roundups', 'nysr']);
const OWN_BODY_FIELDS = ['fullText', 'bwwExcerpt', 'dtliExcerpt', 'showScoreExcerpt', 'playbillExcerpt'];
const EXCERPT_FIELDS = ['nycTheatreExcerpt', 'nysrExcerpt'];

/** Shows whose reviews are never from a New York production: city-hub regional rows and tours. */
function isLocalOrTourShow(show) {
  if (!show) return false;
  return show.localOnly === true || show.category === 'regional' || show.category === 'tour' || show.market === 'tour' || show.market === 'regional';
}

/**
 * @param {{ url?: string|null, source?: string, sources?: string[] }} review
 * @param {{ localOnly?: boolean, category?: string, market?: string }} show
 * @returns {boolean} true when the review must not count for this show
 */
function isNycRoundupExcerptOnLocalShow(review, show) {
  if (!review || !isLocalOrTourShow(show)) return false;
  if (review.url) return false; // a real outlet URL is judged by the other guards (venue mismatch, dates)
  const fromRoundup = ROUNDUP_SOURCES.has(review.source) || (Array.isArray(review.sources) && review.sources.some((s) => ROUNDUP_SOURCES.has(s)));
  const hasExcerpt = EXCERPT_FIELDS.some((k) => review[k]);
  // Another substantive body (own full text or a local aggregator excerpt) means the file is not roundup-only.
  if (OWN_BODY_FIELDS.some((k) => review[k])) return false;
  return fromRoundup || hasExcerpt;
}

module.exports = { isNycRoundupExcerptOnLocalShow, isLocalOrTourShow, ROUNDUP_SOURCES };
