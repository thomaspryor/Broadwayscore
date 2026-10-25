'use strict';

/**
 * BRO-125 (owner rule 2026-07-30): "It's only important to catch shows that
 * get 3+ reviews, IMO, otherwise there's very little critical or audience
 * signal to be useful." Replaces the old "a PV/BWW roundup article exists"
 * proxy in promote-ob-venue-candidates.js's decideRegionalPromotion with a
 * real count of distinct review outlets extracted from that same article
 * (see scripts/lib/aggregator-candidate-extract.js#countDistinctReviewOutlets,
 * the caller that supplies candidate.reviewCount).
 *
 * Kept pure/IO-free (CLAUDE.md §15 test-extraction pattern): takes a
 * reviewCount number the caller already extracted, never touches HTML,
 * network, or the filesystem itself.
 */

const REGIONAL_REVIEW_THRESHOLD = 3;

/** True when reviewCount is a real, finite number at or above threshold. */
function meetsReviewThreshold(reviewCount, threshold = REGIONAL_REVIEW_THRESHOLD) {
  return typeof reviewCount === 'number' && Number.isFinite(reviewCount) && reviewCount >= threshold;
}

/**
 * Pure promotion-gate decision: "does this candidate name enough distinct
 * review outlets to go live." Fails closed on a missing/unparseable count —
 * an unknown count is never treated as "enough," unlike the old roundup-
 * exists proxy which confirmed the moment a roundup-sourced record existed
 * at all, regardless of how many critics it actually named.
 *
 * @param {{reviewCount?: number|null}} candidate
 * @param {{threshold?: number}} [options]
 * @returns {{confirmed: boolean, reason: string}}
 */
function decideReviewThresholdPromotion(candidate, options = {}) {
  const threshold = options.threshold ?? REGIONAL_REVIEW_THRESHOLD;
  const count = candidate && candidate.reviewCount;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return {
      confirmed: false,
      reason: 'reviewCount missing or unparseable — cannot confirm the 3+ distinct-review threshold',
    };
  }
  if (count < threshold) {
    return {
      confirmed: false,
      reason: `only ${count} distinct review outlet(s) found — needs ${threshold}+ (owner rule 2026-07-30)`,
    };
  }
  return {
    confirmed: true,
    reason: `${count} distinct review outlets found (>= ${threshold})`,
  };
}

module.exports = {
  REGIONAL_REVIEW_THRESHOLD,
  meetsReviewThreshold,
  decideReviewThresholdPromotion,
};
