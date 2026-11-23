'use strict';

/**
 * dedupByCritic — keep one review per (outlet, critic) pair, most recent by
 * publishDate. This is the SINGLE SOURCE OF TRUTH for "how many live review
 * entries a show has", shared by:
 *   - generate-mobile-show-details.js  (builds the prod slim `rv` array)
 *   - verify-opening-night-live.js      (checks prod `rv` is complete)
 * They MUST agree: if this dedup and the prod-rv dedup ever diverge, the
 * live-verify alerter fires forever on perfectly healthy multi-critic-per-outlet
 * shows (NYSR/NYT publish several critics per outlet). Keeping it in one place
 * makes that drift impossible. Pure — testable.
 */
/**
 * The (outlet, critic) identity key. ONE definition: compute-critic-score.js
 * scoreReviews() dedups with it too (BRO-8104). They used to differ for an
 * unbylined review ('unknown' here, '__unknown__' there), so a critic literally
 * named "Unknown" collapsed with unbylined rows on the slim path and not on the
 * page path.
 */
function reviewIdentityKey(review) {
  const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
  const criticKey = (review.criticName || '__unknown__').toLowerCase();
  return `${outletKey}|${criticKey}`;
}

function dedupByCritic(reviews) {
  const byCriticKey = new Map();
  for (const review of reviews) {
    const key = reviewIdentityKey(review);
    const existing = byCriticKey.get(key);
    if (!existing || (review.publishDate || '') > (existing.publishDate || '')) {
      byCriticKey.set(key, review);
    }
  }
  return Array.from(byCriticKey.values());
}

module.exports = { dedupByCritic, reviewIdentityKey };
