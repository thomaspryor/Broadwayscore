/**
 * Aggregator-First Discovery for Opening Night Shows (BRO-736)
 *
 * Pure decision functions used by gather-reviews.js's --opening-night mode.
 *
 * Background: isUrlYearOutsideWindow (content-filters.js) grants SERP results
 * a -3y grace on the show's opening year, so a revival/transfer within 3 years
 * of a prior production's own run is NOT rejected by the general-purpose guard.
 * For Cats (Broadway revival 2026, Off-Broadway "Jellicle Ball" run 2024), the
 * 2-year gap sailed through that grace window — 27/32 discovered files were
 * the WRONG production. On opening night specifically, an undeclared same-title
 * hit from an earlier year is essentially always a different production (the
 * legitimate case — a real prior run — is already declared via priorRuns /
 * tourLegs, which this module still readmits). Opting into a 0-grace year
 * check via --opening-night avoids touching isUrlYearOutsideWindow's shared,
 * broadly-used default behavior (CLAUDE.md rule 18 — review before editing
 * shared guards).
 *
 * Used by:
 * - scripts/gather-reviews.js (--opening-night flag)
 * - tests/unit/gather-reviews-opening-night.test.mjs
 */

const { isUrlYearInPriorRun, isUrlYearInTourLeg, URL_YEAR_PATTERN } = require('./url-discovery');

/**
 * Extract a 4-digit year embedded in a URL path, or null if none found.
 * @param {string} url
 * @returns {number|null}
 */
function extractUrlYear(url) {
  if (!url) return null;
  const m = String(url).match(URL_YEAR_PATTERN);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Strict (zero-grace) check for whether a SERP-discovered URL is almost
 * certainly the wrong production for an opening-night show. Unlike
 * isUrlYearOutsideWindow's -3y grace, this rejects any embedded year outside
 * a tight window around the show's opening year — unless that year is
 * explicitly readmitted by a declared priorRuns or tourLegs window.
 *
 * The window is opening year only, EXCEPT a Nov/Dec opening also admits
 * openingYear+1 — press for a late-December opening routinely publishes in
 * the first days of January (adversarial ship-check review, BRO-736: an
 * exact-match-only window silently drops those legitimate reviews).
 *
 * Returns false (not suspicious) when the URL has no embedded year — most
 * outlet URLs don't encode one, and this check only exists to catch the
 * embedded-year case the general-purpose guard's grace period misses.
 *
 * @param {string} url
 * @param {{openingDate?: string, priorRuns?: Array, tourLegs?: Array}} show
 * @returns {boolean}
 */
function isSerpUrlWrongProductionForOpeningNight(url, show) {
  if (!url || !show || !show.openingDate) return false;
  const urlYear = extractUrlYear(url);
  if (urlYear == null) return false;

  const openingDate = new Date(show.openingDate);
  const openingYear = openingDate.getFullYear();
  if (isNaN(openingYear)) return false;

  const spillsIntoNextYear = openingDate.getUTCMonth() >= 10; // Nov (10) or Dec (11)
  if (urlYear === openingYear) return false;
  if (spillsIntoNextYear && urlYear === openingYear + 1) return false;

  if (isUrlYearInPriorRun(url, show.priorRuns)) return false;
  if (isUrlYearInTourLeg(url, show.tourLegs)) return false;

  return true;
}

/**
 * Split a list of found reviews (gather-reviews.js's foundReviews array) into
 * SERP-sourced vs aggregator/other-sourced counts, and the resulting SERP
 * share of the total. Pure — takes the array, returns numbers.
 *
 * @param {Array<{source?: string}>} foundReviews
 * @returns {{serpCount: number, aggregatorCount: number, total: number, serpRatio: number}}
 */
function computeSerpShare(foundReviews) {
  const reviews = Array.isArray(foundReviews) ? foundReviews : [];
  const serpCount = reviews.filter(r => typeof r.source === 'string' && r.source.startsWith('serp-discovery')).length;
  const total = reviews.length;
  const aggregatorCount = total - serpCount;
  const serpRatio = total > 0 ? serpCount / total : 0;
  return { serpCount, aggregatorCount, total, serpRatio };
}

/**
 * Acceptance criteria (BRO-736): opening-night runs should keep SERP-sourced
 * reviews at or under 20% of the total. Pure threshold check over a ratio
 * already computed by computeSerpShare.
 *
 * @param {number} serpRatio
 * @param {number} [threshold=0.2]
 * @returns {boolean}
 */
function exceedsOpeningNightSerpBudget(serpRatio, threshold = 0.2) {
  return serpRatio > threshold;
}

/**
 * Parse gather-reviews.js's CLI flags. Extracted from main() so the flag set
 * (including --opening-night) is unit-testable without invoking the script.
 *
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{showIds: string[]|null, aggregatorsOnly: boolean, validateUrls: boolean, historical: boolean, openingNight: boolean}}
 */
function parseGatherReviewsFlags(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const showsArg = args.find(a => a.startsWith('--shows='));
  const showIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()) : null;
  return {
    showIds,
    aggregatorsOnly: args.includes('--aggregators-only'),
    validateUrls: args.includes('--validate-urls'),
    historical: args.includes('--historical'),
    openingNight: args.includes('--opening-night'),
  };
}

module.exports = {
  extractUrlYear,
  isSerpUrlWrongProductionForOpeningNight,
  computeSerpShare,
  exceedsOpeningNightSerpBudget,
  parseGatherReviewsFlags,
};
