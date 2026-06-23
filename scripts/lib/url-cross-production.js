'use strict';
/**
 * URL cross-production ownership decision.
 *
 * When the same review URL is found under two productions of the same title
 * (e.g. a Broadway run and a later West End revival), gather-reviews.js must
 * decide which production legitimately owns it. The only trustworthy signal is
 * the review's own year vs. each production's year.
 *
 * Rule: a production takes ownership ONLY when the review's year is strictly
 * closer to it than to the incumbent. Unknown review year, or an exact tie,
 * returns false → first-writer-wins, no re-homing.
 *
 * History: the previous heuristic awarded the URL to the *more recent*
 * production whenever the review year couldn't be extracted (and on ties).
 * Because publishDate is often enriched AFTER the URL sweep runs, this silently
 * re-homed legitimate older reviews onto newer same-title revivals and flagged
 * the originals wrongProduction — suppressing real reviews from scoring. ≥9
 * confirmed mis-homings (Les Liaisons 2016→2026, Hello Dolly 1995→2017,
 * Shucked 2023→2026, …) traced to this branch. 2026-06-23.
 *
 * @param {object} p
 * @param {number|null|undefined} p.reviewYear  Year the review was published.
 * @param {number|null|undefined} p.thisYear    Year of the production seeking ownership.
 * @param {number|null|undefined} p.existingYear Year of the production currently holding the URL.
 * @returns {boolean} true → re-home the URL to `thisYear`'s production.
 */
function shouldTakeUrlOwnership({ reviewYear, thisYear, existingYear } = {}) {
  if (!reviewYear || !thisYear || !existingYear) return false;
  return Math.abs(thisYear - reviewYear) < Math.abs(existingYear - reviewYear);
}

module.exports = { shouldTakeUrlOwnership };
