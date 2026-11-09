/**
 * The show page's Coverage Verdict floor, shared by the website
 * (src/config/score-buckets.ts re-exports it) and the app feed
 * (scripts/lib/mobile-critic-score.js emits it as `cr.pq`), so the app's show
 * page hides and shows a score exactly when the website's does.
 *
 * Pure: no fs, so client bundles that import score-buckets.ts can carry it.
 * The loader for its inputs is scripts/lib/coverage-floor-inputs.js.
 */

'use strict';

/** Hours a score must have been public before the floor protects it. */
const SCORE_REGRESSION_FLOOR_HOURS = 24;

/**
 * Ceiling on the never-public coverage hold (BRO-7197). On Wanted's opening night (2026-11-08) the census held three
 * pages that were not reviews (a video feature and two listings), so the page said "Awaiting Reviews" with 18 reviews
 * scored until a session acked the gap by hand. The census can always carry one bad row; the hold must not be able to
 * hide a score past these limits:
 *  - COVERAGE_HOLD_MAX_SCORED_REVIEWS scored reviews in (the acceptance bar the card set), or
 *  - COVERAGE_HOLD_MAX_HOURS after midnight UTC of the opening date (about 49h after a 7pm ET curtain), for a
 *    small show that never reaches the count.
 */
const COVERAGE_HOLD_MAX_SCORED_REVIEWS = 8;
const COVERAGE_HOLD_MAX_HOURS = 72;

/**
 * True when the coverage hold no longer applies to this show, whatever the census says.
 * @param {{scoredReviewCount?: number | null, openingDate?: string | null, now?: number}} [opts]
 * @returns {boolean}
 */
function coverageHoldReleased(opts = {}) {
  if (Number.isFinite(opts.scoredReviewCount) && opts.scoredReviewCount >= COVERAGE_HOLD_MAX_SCORED_REVIEWS) return true;
  if (opts.openingDate) {
    const openMs = Date.parse(opts.openingDate);
    const now = opts.now ?? Date.now();
    if (Number.isFinite(openMs) && now - openMs > COVERAGE_HOLD_MAX_HOURS * 3600 * 1000) return true;
  }
  return false;
}

/**
 * Adjusts the plain review-count TBD gate (`!hasEnoughReviews(...)`) with two
 * Coverage Verdict rules:
 *  1. Never-public + incomplete coverage: a show whose score has NEVER been
 *     public stays in "Awaiting Reviews" even if reviewCount clears the
 *     normal threshold, as long as the coverage verdict says known
 *     aggregator-cited reviews are still missing (and the gap isn't acked).
 *  2. Score-regression floor: once `scorePublicSince` is >24h old, the score
 *     is shown regardless of anything else — a later verdict change, a
 *     flagged review dropping reviewCount back under threshold, etc. can
 *     never make an already-settled score disappear again.
 *
 * Fails open: no `coverageState` (missing/unreadable audit, kill switch) or
 * `coverageAcked` never blocks — only an explicit 'incomplete' verdict on a
 * never-public show does.
 *
 * @param {boolean} reviewCountTBD  the existing `!hasEnoughReviews(...)` result
 * @param {{scorePublicSince?: string | null, coverageState?: string | null, coverageAcked?: boolean, now?: number, scoredReviewCount?: number | null, openingDate?: string | null}} [opts]
 *   scorePublicSince: ISO timestamp of the first time this show's score
 *   cleared the review-count threshold, or null/undefined if never.
 *   coverageState: the show's `cov.state` field ('complete' | 'incomplete' |
 *   'no-census-yet' | undefined).
 *   coverageAcked: true when the owner has acknowledged this show's coverage
 *   gap (the t1-scoreboard ack store's 'newsletter-gap' namespace,
 *   `data/audit/t1-coverage-ack.json`, populated via
 *   `pre-send-check.mjs --ack-gap=<showId>`; the same ack covers both the
 *   newsletter swap gate and this floor).
 *   now: ms epoch, defaults to Date.now() — inject in tests.
 *   scoredReviewCount / openingDate: the coverageHoldReleased() ceiling inputs (BRO-7197). Callers that cannot pass
 *   them get the ceiling through coverageAcked instead (src/lib/data-core.ts folds it in once per show).
 * @returns {boolean} true when the show should show "Awaiting Reviews" instead of its score.
 */
function applyCoverageFloor(reviewCountTBD, opts = {}) {
  if (opts.scorePublicSince) {
    const publicMs = Date.parse(opts.scorePublicSince);
    if (Number.isFinite(publicMs)) {
      const now = opts.now ?? Date.now();
      if (now - publicMs > SCORE_REGRESSION_FLOOR_HOURS * 3600 * 1000) return false; // floor wins outright
    }
  }
  if (reviewCountTBD) return true;
  if (!opts.scorePublicSince && opts.coverageState === 'incomplete' && !opts.coverageAcked && !coverageHoldReleased(opts)) return true;
  return false;
}

module.exports = {
  SCORE_REGRESSION_FLOOR_HOURS, COVERAGE_HOLD_MAX_SCORED_REVIEWS, COVERAGE_HOLD_MAX_HOURS, applyCoverageFloor, coverageHoldReleased,
};
