/**
 * Identify West End long-runners — productions that have run continuously
 * for decades and whose reviews legitimately span a wide publishDate range.
 *
 * Motivating cases (WE long-runner CV hardening card 34c637c5-416f-812b #3):
 *   - the-mousetrap-west-end-2021 (running since 1952)
 *   - the-phantom-of-the-opera-west-end-1986 (since 1986, ID year matches opening)
 *   - les-miserables-west-end-2021 (since 1985, transferred theatres 2004/2019)
 *   - mamma-mia-west-end-2021 (since 1999)
 *
 * CV was flagging legitimate decades-old reviews as wrongProduction because
 * publishDate vs openingDate distance looked suspicious. The real signal is
 * "production has run continuously" — flip it and ask the LLM to be lenient
 * on the age gap for these shows.
 *
 * Extracted from scripts/rebuild-all-reviews.js:771 (Phase B of this work).
 * rebuild-all-reviews still uses the Set API for its pre-opening guard
 * (skipping 90-day-before-opening filters for long-runners); content-verifier
 * uses the single-show classifier to expand its LLM prompt.
 */

const { isLondonMarket } = require('./venue-classification');

const LONG_RUN_CUTOFF_YEAR = 2015;
const ID_YEAR_GAP_THRESHOLD = 5;

/**
 * Decide whether a show is a WE long-runner.
 *
 * Rules:
 *  1. Must be a London-market show (west-end / off-west-end).
 *  2. Must have an openingDate.
 *  3. Either:
 *     (a) openingDate year < LONG_RUN_CUTOFF_YEAR, OR
 *     (b) the showId suffix year is < LONG_RUN_CUTOFF_YEAR AND the stored
 *         openingDate year is > ID_YEAR_GAP_THRESHOLD later (catches Phantom's
 *         2021 COVID-reopen date stamped on a 1986 show).
 *
 * Rule (b) is defensive: before 2026-04-24 issue #1 fix, Phantom WE had
 * openingDate=2021-08-10. Issue #1 corrected that to 1986-10-09, but rule (b)
 * keeps the classifier robust against similar drift landing on other shows.
 *
 * @param {object} show — shows.json entry. Required: category, id, openingDate.
 * @returns {boolean}
 */
function isLongRunningProduction(show) {
  if (!show) return false;
  if (!isLondonMarket(show.category)) return false;
  if (!show.openingDate) return false;

  const openYear = new Date(show.openingDate).getFullYear();
  if (!Number.isFinite(openYear)) return false;

  if (openYear < LONG_RUN_CUTOFF_YEAR) return true;

  const idYearMatch = String(show.id || '').match(/(\d{4})$/);
  if (!idYearMatch) return false;
  const idYear = parseInt(idYearMatch[1], 10);
  if (!Number.isFinite(idYear)) return false;

  return idYear < LONG_RUN_CUTOFF_YEAR && openYear - idYear > ID_YEAR_GAP_THRESHOLD;
}

/**
 * Batch form for rebuild-all-reviews.js: build a Set of long-runner IDs.
 *
 * @param {Array<object>} shows
 * @returns {Set<string>}
 */
function buildLongRunnerSet(shows) {
  const set = new Set();
  if (!Array.isArray(shows)) return set;
  for (const s of shows) {
    if (isLongRunningProduction(s)) set.add(s.id);
  }
  return set;
}

module.exports = {
  isLongRunningProduction,
  buildLongRunnerSet,
  LONG_RUN_CUTOFF_YEAR,
  ID_YEAR_GAP_THRESHOLD,
};
