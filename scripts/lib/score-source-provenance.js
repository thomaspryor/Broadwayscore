'use strict';
/**
 * BRO-5055: set data.scoreSource to a scoring-METHOD label (LLM 'anchored-v6',
 * 'llm-v6', 'manual-cleared-haiku-fallback') without losing what the old label
 * said about where the star came from.
 *
 * bodylessScoreProvenance() (review-guards.js, BRO-3135) infers provenance from
 * scoreSource. Overwriting e.g. 'guardian-star-svg' with 'anchored-v6' flipped a
 * page-parsed body-less file to 'aggregator-inherited', and the rebuild's
 * isBodylessAggregatorScoreUncorroborated gate dropped it (annie-west-end-2017
 * 6->3 on 2026-10-22; the review came back only once full text was collected,
 * which is why these dips looked transient).
 *
 * When the file is page-parsed, that verdict is stamped as an explicit
 * scoreProvenance before the overwrite. An aggregator-inherited verdict is never
 * stamped: the overwrite keeps that inference anyway, and an explicit stamp
 * would bypass the legacy rollout exemption in the gate.
 * Mutates and returns data.
 */
function setScoreSourcePreservingProvenance(data, newScoreSource) {
  if (!data) return data;
  const { bodylessScoreProvenance } = require('./review-guards'); // lazy: heavy module
  if (!data.scoreProvenance) {
    // Judge as if body-less: a file with a body now can be emptied later and
    // would then read as aggregator-inherited under its method label.
    const hasScore = !!(data.aggregatorStars || data.originalScore != null
      || typeof data.originalScoreNormalized === 'number');
    if (hasScore && bodylessScoreProvenance({ ...data, fullText: '' }) === 'page-parsed') {
      data.scoreProvenance = 'page-parsed';
    }
  }
  data.scoreSource = newScoreSource;
  return data;
}

module.exports = { setScoreSourcePreservingProvenance };
