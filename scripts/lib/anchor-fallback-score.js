'use strict';

/**
 * anchor-fallback-score.js (BRO-6121) — the single-model Haiku fallback in
 * scripts/llm-scoring/index.ts (human-cleared files the ensemble rejected) scored
 * with ReviewScorer, which has no star band. In an anchored market the result
 * carried no llmScore.band, so detect-star-band-regressions.js re-flagged it
 * `unanchored` every time, the drain re-ran the same unanchored fallback, and the
 * star-band:regressions alert never resolved. This applies the same band the
 * ensemble would have used: clamp into [floor, ceiling] and stamp llmScore.band
 * (the marker needsLateStarReanchor treats as "anchored").
 *
 * Detection runs on the PRE-score file, exactly as EnsembleReviewScorer.prepareScoringInput does.
 * Pure (mutates and returns `scored`).
 */

const { detectBandFromReviewFile, shouldUseAnchoredMode } = require('./star-reliability');

function anchorFallbackScore(scored, reviewFile) {
  if (!scored || !scored.llmScore || typeof scored.llmScore.score !== 'number') return scored;
  if (!shouldUseAnchoredMode({ category: reviewFile && reviewFile.category, envFlag: process.env.ANCHORED_BANDS_PILOT === '1' })) return scored;
  const det = detectBandFromReviewFile(reviewFile);
  if (!det || !det.band || !det.highReliability) return scored;
  const { floor, ceiling, fraction } = det.band;
  const clamped = Math.max(floor, Math.min(ceiling, scored.llmScore.score));
  if (clamped !== scored.llmScore.score) {
    scored.llmScore.unclampedScore = scored.llmScore.score;
    scored.llmScore.score = clamped;
  }
  if (typeof scored.assignedScore === 'number') scored.assignedScore = Math.max(floor, Math.min(ceiling, scored.assignedScore));
  scored.llmScore.band = { floor, ceiling, fraction };
  return scored;
}

module.exports = { anchorFallbackScore };
