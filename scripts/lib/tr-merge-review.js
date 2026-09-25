'use strict';

/**
 * mergeTrReviewOnExisting — the --no-skip-existing merge decision for
 * extract-theatre-record.js, extracted per CLAUDE.md rule 15 so it's
 * require()-able from a test instead of only exercised live.
 *
 * BRO-4152 #3: a bare "!merged.fullText" check left a non-blank-but-bad body
 * (paywall stub, invalid tier, needsRefetch) on disk forever even after TR's
 * complete text became available, while contentTier still got silently
 * bumped toward "complete" alongside the stale body. isPreExistingContentBad
 * gates fullText/textWordCount/contentTier/contentTierReason together —
 * replace all four, or none.
 *
 * The old body's wrongShow/wrongProduction verdict and any prior score
 * describe content that's gone the moment the replacement lands — leaving
 * them attached keeps a stale rejection (review-guards.js's
 * isIncludableForRebuild) or a stale llmScore (which permanently skips the
 * default unscoredOnly scoring pass, llm-scoring/index.ts) pinned to the NEW,
 * already-guard-validated TR text (adversarial review, BRO-4152:
 * kinky-boots-the-musical-west-end-2026's Daily Mail file carried a score and
 * a wrongShow verdict for a Clueless/Farewell Mister Haffmann roundup that
 * TR's real text would have replaced).
 */

const { isPreExistingContentBad } = require('./stale-merge-check');
const { clearWrongProductionFlags } = require('./wrong-production-clear');

// Deliberately excludes originalScore/originalScoreNormalized/scoreSource/
// aggregatorStars: those are extracted from the outlet's own page HTML
// (independent of which text landed in fullText), and this merge never
// touches `url`, so they aren't necessarily stale — clearing them risks
// discarding still-good data with no compensating benefit.
const SCORE_DERIVED_FIELDS_TO_CLEAR = [
  'llmScore', 'llmMetadata', 'ensembleData', 'assignedScore',
  'needsReview', 'needsReviewReason', 'rejectedAt', 'rejectedBy', 'rejectionReason',
  'rejectionReasoning', 'contentVerificationPromoted', 'incompleteReason',
  'incompleteDetail', 'textQuality', 'truncationSignals', 'textStatus',
  'classifiedAt', 'promptVersion', '_scoreNote',
];

/**
 * @param {object} existing - the review file's current contents, read from disk
 * @param {object} reviewData - the freshly-built TR review record (already
 *   passed every wrong-show/wrong-production/film-TV guard against its OWN
 *   fullText before this is called)
 * @returns {object} the merged record to write back — a NEW object, `existing`
 *   and `reviewData` are not mutated
 */
function mergeTrReviewOnExisting(existing, reviewData) {
  const merged = { ...existing };
  if (isPreExistingContentBad({ data: existing }) && reviewData.fullText) {
    merged.fullText = reviewData.fullText;
    merged.textWordCount = reviewData.textWordCount;
    merged.contentTier = reviewData.contentTier;
    merged.contentTierReason = reviewData.contentTierReason;
    clearWrongProductionFlags(merged, {
      source: 'extract-theatre-record.js:tr-merge',
      reason: 'TR full text replaced a paywall stub/invalid-tier body',
    });
    for (const field of SCORE_DERIVED_FIELDS_TO_CLEAR) delete merged[field];
    if (merged.needsRefetch) merged.needsRefetch = false;
  }
  merged.theatreRecordUrl = reviewData.theatreRecordUrl;
  if (!merged.source) merged.source = 'theatre-record';
  if (merged.source && !merged.sources) merged.sources = [merged.source];
  if (merged.sources && !merged.sources.includes('theatre-record')) merged.sources.push('theatre-record');
  return merged;
}

module.exports = { mergeTrReviewOnExisting, SCORE_DERIVED_FIELDS_TO_CLEAR };
