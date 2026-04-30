/**
 * JS twin of scripts/llm-scoring/is-scoreable.ts.
 * Both files MUST stay in lockstep — see Notion 34f637c5-416f-810d.
 *
 * Delegates to isIncludableForRebuild and layers LLM-only extras. See the
 * .ts file's docstring for why.
 */
const { hasExcerpt } = require('./excerpt-fields');
const { isIncludableForRebuild } = require('./review-guards');

function isScoreable(data, show) {
  if (!isIncludableForRebuild(data, show)) return false;
  if (data.incompleteReason === 'scraper_garbage') return false;
  if (data.showNotMentioned && !hasExcerpt(data)) return false;
  return true;
}

module.exports = { isScoreable };
