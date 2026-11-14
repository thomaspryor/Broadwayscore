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

/**
 * Does the copy currently holding a shared URL give it up to another show?
 *
 * Junk (invalid tier, wrongShow, wrong/garbage content, a wrongArticle verdict)
 * always did. BRO-6909 adds a copy its own show has already disowned as another
 * production (wrongProduction, or rejected with reason wrong_production) unless a
 * person cleared or overrode that verdict. Without it, ENO's "Tosca" (London
 * Coliseum, 2026) could not save the FT / Telegraph / Times reviews: the Met's
 * "Tosca" (also 2026) had collected them first and rejected them as wrong
 * production, the years tie, and first-writer-wins kept them there, hidden.
 * The incoming copy still faces its own show's production guards.
 *
 * @param {object|null} existingData the holder's review file
 * @returns {boolean}
 */
function existingCopyYieldsUrl(existingData) {
  const { shouldSkipWrongProductionAudit } = require('./review-guards');
  const d = existingData;
  if (!d || typeof d !== 'object') return false;
  if (d.contentTier === 'invalid'
    || d.wrongShow === true
    || d.incompleteReason === 'wrong_content'
    || d.incompleteReason === 'scraper_garbage'
    || (d.contentVerification && d.contentVerification.wrongArticle === true)) return true;
  const disowned = d.wrongProduction === true || d.rejectionReason === 'wrong_production';
  // A person cleared or overrode the verdict: the copy stays the URL's owner.
  return disowned && !shouldSkipWrongProductionAudit(d);
}

module.exports = { shouldTakeUrlOwnership, existingCopyYieldsUrl };
