'use strict';

/**
 * band-anchored.js — is this review's score clamped to its critic's explicit
 * star/grade band (anchored-v6)?
 *
 * Anything that recomputes a score from the stored per-model scores
 * (scripts/re-ensemble-scores.ts) must leave these alone: the stored model
 * scores are pre-clamp, so re-ensembling them silently drops the band and
 * moves a starred review off its critic's own rating. Found while fitting
 * BRO-4335: ~4.4k anchored reviews were exposed.
 *
 * @param {Object} data - review-text record
 * @returns {boolean}
 */
function isBandAnchored(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.scoreSource === 'anchored-v6') return true;
  const band = data.llmScore && data.llmScore.band;
  return !!(band && typeof band.floor === 'number' && typeof band.ceiling === 'number');
}

module.exports = { isBandAnchored };
