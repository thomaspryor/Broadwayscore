/**
 * JS twin of scripts/llm-scoring/is-scoreable.ts.
 * Both files MUST stay in lockstep — see Notion 34f637c5-416f-810d.
 *
 * Delegates to isIncludableForRebuild and layers LLM-only extras. See the
 * .ts file's docstring for why.
 */
const { hasExcerpt } = require('./excerpt-fields');
const { isIncludableForRebuild } = require('./review-guards');
const { laneBypasses } = require('./opening-night-lane/trust-model');

function isScoreable(data, show, filePath) {
  if (!isIncludableForRebuild(data, show, filePath)) return false;
  // BRO-4806: scraper_garbage is a lane-bypassed guard (a lane review is production-verified by an aggregator).
  if (data.incompleteReason === 'scraper_garbage' && !laneBypasses(data, 'scraperGarbage', { openingDate: show && show.openingDate })) return false;
  // headlineBackstop: the show-name-not-in-text check (rebuild's skippedShowNotMentioned gate) also stands down.
  if (data.showNotMentioned && !hasExcerpt(data) && !laneBypasses(data, 'headlineBackstop', { openingDate: show && show.openingDate })) return false;
  return true;
}

module.exports = { isScoreable };
