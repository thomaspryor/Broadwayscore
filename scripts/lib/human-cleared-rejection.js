'use strict';
/**
 * human-cleared-rejection.js: does a person's clear on this review overrule the ensemble's rejection verdict?
 *
 * llm-scoring/index.ts calls this before writing rejectedAt / rejectedBy / rejectionReason. When it returns true the
 * scorer scores the text with the single-model Haiku fallback instead of re-stamping the rejection, because
 * review-guards.js excludes any file that carries a rejectedAt the human clear does not defer.
 *
 *   wrong_production / wrong_show: a production or show clear (2026-04-22 audit B-class clears; aliases from the
 *     2026-05-01 opera sweeps), a combined review (issue 316), or an opening-night lane review (BRO-4807).
 *   not_a_review (BRO-4838): a person said the file IS a review (nonReviewManualClear, or a wrongArticle clear, the
 *     same test the rebuild uses: cvNonReviewHumanCleared). Before this, the scorer re-rejected such files on their
 *     next pass; From the Heart (Theatre News) was restored and re-rejected the same evening.
 *   garbage_text: never. A clear says what the article is, not that the stored text is readable.
 */
const { laneBypasses } = require('./opening-night-lane/trust-model');

function productionOrShowCleared(d) {
  return d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.wrongShowManualClear === true ||
    d.wrongShowOverride === true ||
    d.humanReviewedWrongProduction === false ||
    d.isCombinedReview === true ||
    d.wrongProductionCleared === true ||
    d.wrongShowCleared === true ||
    laneBypasses(d, 'wrongProduction');
}

/** Returns the clear that overrules `rejection` ('production-or-show' | 'non-review'), or null. */
function humanClearOverridingRejection(d, rejection) {
  if (!d || typeof d !== 'object') return null;
  if ((rejection === 'wrong_production' || rejection === 'wrong_show') && productionOrShowCleared(d)) return 'production-or-show';
  if (rejection === 'not_a_review' && require('./review-guards').cvNonReviewHumanCleared(d)) return 'non-review';
  return null;
}

module.exports = { humanClearOverridingRejection };
