/**
 * The 6 exclusion branches audit-outlet-registry.js uses to decide a review
 * file never needs a registry entry (BRO-3804). Extracted to a pure function
 * so scripts/outlet-registry.test.mjs can exercise each branch against
 * synthetic fixtures without real review-texts (memory: Test Extraction
 * Pattern — never re-copy this logic into the test file).
 *
 * Each comment mirrors the rationale inline in audit-outlet-registry.js;
 * see that file for the full incident history behind each branch.
 */
const { isNonReviewDemotedByFreshCV, isRejectedNonReview, wrongShowCleared, hasValidScore } = require('./review-guards');
const { isBlockedReviewUrl } = require('./domain-filters');
// The rebuild's OWN include predicate (rebuild-all-reviews.js wraps this same
// function for its skippedNoScore decision) — branch 6 must agree with it
// exactly, not with hasValidScore(): a corpus scan found 532 files that
// hasValidScore accepts (single-model llmScore, aggregatorStars on a
// non-star outlet) which getBestScore refuses, and 740 the other way.
const { getBestScore } = require('./rebuild-helpers');
const { WRONG_URL_INCOMPLETE } = require('./t1-silent-gap');

const WRONG_PRODUCTION_REJECTION_REASONS = new Set(['wrong_production', 'wrong_show']);

/**
 * @param {object} review parsed review-text JSON
 * @returns {boolean} true when this review file never needs a registry entry
 */
function isExcludedFromOutletRegistryAudit(review) {
  return outletRegistryAuditExclusionBranch(review) !== 0;
}

/**
 * Which branch excludes this file — 1..6 — or 0 when none does. The audit
 * uses the number to count branch-6 (unscored) exclusions on their own
 * without re-deriving the earlier branches (BRO-4401).
 * @param {object} review parsed review-text JSON
 * @returns {number}
 */
function outletRegistryAuditExclusionBranch(review) {
  // 1. Content-quality pipeline already flagged this as not a review at all.
  if (review.isNonReview === true && !isNonReviewDemotedByFreshCV(review)) return 1;

  // 2. ensemble-scoreability-check rejected ingest-time junk.
  if (isRejectedNonReview(review)) return 2;

  // 3. URL on a known non-review domain.
  if (review.url && isBlockedReviewUrl(review.url)) return 3;

  // 4. Confidently rejected as wrong_production/wrong_show, never manually cleared.
  if (
    WRONG_PRODUCTION_REJECTION_REASONS.has(review.rejectionReason) &&
    review.rejectedAt &&
    !wrongShowCleared(review)
  ) return 4;

  // 5. Content-quality pipeline flagged the file's URL as pointing at the
  // wrong content at write time (BRO-3794) — a re-fetch of the same URL can
  // only re-ingest more garbage, so this file supplies no registry
  // requirement either (its outletId may still be covered by other files —
  // see the hasValidScore/wrongShowCleared guards below). Reuses the SAME
  // narrow set t1-silent-gap.js's
  // hasWrongUrlSignal checks first, not the full signal (which also covers
  // isBlockedReviewUrl/bwwAggregatorAmbiguous — already handled by branch 3
  // above, or out of scope here) and NOT isIncludableForRebuild wholesale
  // (tried before here per branch 4's comment: pulled in duplicateOf/
  // temporal-window/roundup exclusions unrelated to this audit's question).
  //
  // hasValidScore() gate is load-bearing, not optional: incompleteReason is
  // informational metadata that clearFailureFlags() is supposed to null out
  // once a file is scored, but a real-corpus check while building this fix
  // found ~16,000 of 19,534 WRONG_URL_INCOMPLETE-flagged files already carry
  // a valid score (older files a clearFailureFlags call never touched).
  // classifySilentGap gates hasWrongUrlSignal behind the exact same
  // "not already scored" precondition (t1-silent-gap.js:117:
  // `isIncludableForRebuild(file, show) && hasValidScore(file)` short-
  // circuits first) — without mirroring that here, this branch would treat
  // thousands of real, already-scored outlets' reviews as junk and hide a
  // genuine registry gap for any of them (ship-check/Codex adversarial
  // review finding, round 1).
  //
  // wrongShowCleared() exception mirrors branch 4: a second adversarial pass
  // found 28 real files (the-komisar-scoop, nydailynews, etc.) where a human
  // explicitly cleared wrongProduction/wrongShow (wrongProductionManualClear
  // / wrongShowManualClear / humanReviewedWrongProduction:false) — overruling
  // the automated url_content_mismatch verdict — but scoring hadn't happened
  // yet, so hasValidScore() alone still excluded them. A human's "this IS a
  // real review" verdict must win regardless of score-presence, same as it
  // does for branch 4's wrong_production/wrong_show rejections.
  if (
    WRONG_URL_INCOMPLETE.has(review.incompleteReason) &&
    !hasValidScore(review) &&
    !wrongShowCleared(review)
  ) return 5;

  // 6. Not scored (BRO-4401). The rebuild only registers outlets from reviews
  // it INCLUDES, and "Reviews without valid scores are EXCLUDED" (reviews.json
  // _meta.notes; rebuild-all-reviews.js logs them as skippedNoScore) — so
  // nothing can register this outlet until the file scores, and demanding a
  // registry row now is asking for what no pipeline step can supply.
  // 2026-09-29: localwineevents / splitdecision (scoreExtractionPending
  // archive fetches) turned Data Validation red; 2026-09-30 01:32, after the
  // pending-only version of this branch landed: goodstoriespodcast /
  // ourquadcities / crisesnotes — unscored files WITHOUT the pending flag,
  // skippedNoScore by the 01:44 rebuild — turned it red again. Hence the
  // predicate is "unscored", full stop. Once scored, the rebuild registers
  // the outlet with its URL-derived domain on the next run (or stages it),
  // and the file re-enters this audit's scope naturally. The audit counts
  // how long unregistered outlets sit here (advisory), so nothing hides
  // forever unseen.
  if (isUnscoredForRebuild(review)) return 6;

  return 0;
}

/** Branch 6's predicate on its own: the rebuild never includes an unscored
 * file, so it can never register the file's outlet. Exposed so the audit can
 * count how long unregistered outlets have been waiting behind it. */
function isUnscoredForRebuild(review) {
  // A human's explicit wrongProduction/wrongShow clear keeps the file in
  // scope even unscored — the same "a human verdict wins" rule branches 4
  // and 5 already follow (a human who cleared the file can register its
  // outlet by hand; the audit keeps asking rather than going quiet).
  if (wrongShowCleared(review)) return false;
  // Shallow clone: getBestScore is the rebuild's live scorer and may stamp
  // fields on the object it is given; this audit must not mutate a review.
  let best = null;
  try {
    best = getBestScore({ ...review }, { stats: {}, flagForHumanReview: () => {} });
  } catch {
    best = null;
  }
  return best === null || best === undefined;
}

module.exports = {
  isExcludedFromOutletRegistryAudit,
  outletRegistryAuditExclusionBranch,
  isUnscoredForRebuild,
  WRONG_PRODUCTION_REJECTION_REASONS,
};
