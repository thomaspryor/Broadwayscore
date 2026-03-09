/**
 * JS wrapper for the scoreability check.
 * Single source of truth: scripts/llm-scoring/is-scoreable.ts
 * This file mirrors that logic for use in non-TypeScript scripts.
 *
 * IMPORTANT: When updating is-scoreable.ts, update this file too.
 */
const { hasExcerpt } = require('./excerpt-fields');

function isScoreable(data) {
  if (data.duplicateOf || data.wrongShow || data.wrongProduction || data.wrongAttribution || data.contentTier === 'invalid') return false;
  if (data.fullTextWrongAuthor) {
    if (!hasExcerpt(data)) return false;
  }
  if (data.isRoundupArticle) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    if (!hasExcerpt(data)) return false;
  }
  return true;
}

module.exports = { isScoreable };
