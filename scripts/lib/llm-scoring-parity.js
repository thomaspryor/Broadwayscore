'use strict';

const {
  isRejectedByReasonExclusion,
  isRejectedAtExclusion,
  isLikelyStaleRoundupFlag,
  isLikelyStaleWrongShow,
  wrongShowCleared,
  isLikelyStaleSuspectedMisattribution,
  getCriticRegistry,
  invalidTierClearedByHuman,
  isFullTextWrongAuthorActive,
  getBodyStubExclusionReason,
  isCvPartialWindowAdvisory,
} = require('./review-guards');
const { laneBypasses } = require('./opening-night-lane/trust-model');
const { hasExcerpt } = require('./excerpt-fields');

const wpClearedFlags = (data) =>
  data.wrongProductionManualClear === true ||
  data.wrongProductionOverride === true ||
  data.humanReviewedWrongProduction === false;

/**
 * Returns the first firing exclusion reason on the rebuild side, or '' if
 * the file is included. Mirrors isIncludableForRebuild's check order.
 */
function classifyRebuildExclusion(data, show) {
  if (!data) return 'noData';
  // BRO-4806: opening-night lane reviews are exempt from the six lane-bypassed guards (trust-model laneBypasses).
  const laneOk = (guard) => laneBypasses(data, guard, { openingDate: show && show.openingDate });

  if (data.wrongProduction === true && !wpClearedFlags(data) && !laneOk('wrongProduction')) return 'wrongProduction';
  if (data.wrongShow === true && !wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show) && !laneOk('wrongProduction')) return 'wrongShow';
  if (data.wrongAttribution === true) return 'wrongAttribution';
  if (data.duplicateOf) return 'duplicateOf';
  if (data.isRoundupArticle === true && !isLikelyStaleRoundupFlag(data) && !laneOk('roundupUrlSwap')) return 'isRoundupArticle';
  if (
    (data.isNonReview === true ||
    data.isNotReview === true ||
    data.nonReviewFlag === true ||
    data.nonReviewContent === true) && !laneOk('nonReview') && !isCvPartialWindowAdvisory(data)
  ) {
    return 'nonReview';
  }
  if (data.fabricatedEntry === true) return 'fabricatedEntry';
  if (data.isSyndicatedDuplicate === true) return 'isSyndicatedDuplicate';
  if (data.crossOutletDuplicate === true) return 'crossOutletDuplicate';
  // 2026-04-29: rebuild now mirrors LLM's stale-override (review-guards.js:1759).
  // Classifier must defer to the same helper or it drifts.
  if (data.suspectedMisattribution === true && !isLikelyStaleSuspectedMisattribution(data, getCriticRegistry())) {
    return 'suspectedMisattribution';
  }
  if (
    data.contentVerification?.wrongArticle === true &&
    data.contentVerification?.confidence === 'high' && !laneOk('nonReview') &&
    !isCvPartialWindowAdvisory(data) // BRO-6225: mirrors explainExclusion
  ) {
    return 'contentVerificationWrongHigh';
  }
  if (isRejectedByReasonExclusion(data) && !laneOk('wrongProduction')) return 'rejectionReason';
  if (Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2 && !laneOk('wrongProduction')) return 'rejectedBy2plus';
  if (isRejectedAtExclusion(data) && !laneOk('wrongProduction')) return 'rejectedAt';
  const bodyStubReason = getBodyStubExclusionReason(data);
  if (bodyStubReason) return bodyStubReason;
  if (data.incompleteReason === 'wrong_content' && !laneOk('headlineBackstop')) {
    const wpBlocking = data.wrongProduction === true && !wpClearedFlags(data);
    if (data.wrongShow || wpBlocking) return 'incompleteReason_wrong_content';
    const hasText = !!(data.fullText && data.fullText.trim().length >= 200);
    const hasSignal = !!(data.aggregatorStars != null || data.originalScore != null || data.llmScore);
    if (!hasText && !hasSignal) return 'incompleteReason_wrong_content';
  }
  if (data.contentTier === 'invalid' && !wpClearedFlags(data) && !invalidTierClearedByHuman(data) && !laneOk('headlineBackstop')) return 'contentTier_invalid';

  if (isFullTextWrongAuthorActive(data)) {
    const hasExc = !!(
      data.dtliExcerpt ||
      data.bwwExcerpt ||
      data.showScoreExcerpt ||
      data.nycTheatreExcerpt ||
      data.lboRoundupExcerpt ||
      data.stagedoorExcerpt
    );
    if (!hasExc) return 'fullTextWrongAuthor_noExcerpt';
    return ''; // fullTextWrongAuthor with excerpt → included
  }

  const hasText = !!(data.fullText && data.fullText.trim());
  const hasAgg = !!(data.aggregatorStars || data.originalScore != null || data.llmScore);
  if (!hasText && !hasAgg) return 'finalContentGate';

  return '';
}

/**
 * First firing LLM-side exclusion reason, or '' if scoreable.
 * Post-2026-04-29 refactor: LLM delegates to rebuild and layers two extras.
 * Mirrors scripts/lib/is-scoreable.js / scripts/llm-scoring/is-scoreable.ts.
 */
function classifyLlmExclusion(data, show /* unused criticRegistry now */) {
  const rebuildReason = classifyRebuildExclusion(data, show);
  if (rebuildReason) return rebuildReason;
  const laneOk = (guard) => laneBypasses(data, guard, { openingDate: show && show.openingDate });
  if (data.incompleteReason === 'scraper_garbage' && !laneOk('scraperGarbage')) return 'scraper_garbage';
  if (data.showNotMentioned && !hasExcerpt(data) && !laneOk('headlineBackstop')) return 'showNotMentioned_noExcerpt';
  return '';
}


module.exports = { classifyRebuildExclusion, classifyLlmExclusion };
