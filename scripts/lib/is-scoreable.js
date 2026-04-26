/**
 * JS wrapper for the scoreability check.
 * Single source of truth: scripts/llm-scoring/is-scoreable.ts
 * This file mirrors that logic for use in non-TypeScript scripts.
 *
 * IMPORTANT: When updating is-scoreable.ts, update this file too.
 */
const { hasExcerpt } = require('./excerpt-fields');
const { isLikelyStaleRoundupFlag, isLikelyStaleWrongShow, wrongShowCleared } = require('./review-guards');

function isScoreable(data, show) {
  if (data.duplicateOf || data.wrongProduction || data.wrongAttribution || data.contentTier === 'invalid') return false;
  if (data.wrongShow && !wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show)) return false;
  if (data.incompleteReason === 'scraper_garbage') return false;
  if (data.fullTextWrongAuthor) {
    if (!hasExcerpt(data)) return false;
  }
  if (data.isRoundupArticle && !isLikelyStaleRoundupFlag(data)) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    if (!hasExcerpt(data)) return false;
  }
  return true;
}

module.exports = { isScoreable };
