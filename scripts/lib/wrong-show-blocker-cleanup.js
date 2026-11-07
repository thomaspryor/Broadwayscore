/**
 * Pure decision functions for clear-wrong-show-blockers.js — extracted so
 * the deletion predicate and surge guard are unit-testable without touching
 * the filesystem. See scripts/clear-wrong-show-blockers.js for the CLI.
 */

// A wrongShow=true review-text file is "useful" (kept by default) if it
// carries a score, an LLM score, or aggregator data worth preserving.
function hasUsefulWrongShowData(data) {
  const hasScore = !!(data.assignedScore || data.originalScore);
  const hasLlmScore = !!data.llmScore;
  const hasAggData = !!(data.bwwScore || data.bwwExcerpt || data.showScoreRating || data.showScoreExcerpt);
  return hasScore || hasLlmScore || hasAggData;
}

function hasMeaningfulText(data) {
  return (data.fullText || data.text || '').length > 100;
}

// includeScored=true is the aggressive mode: delete even files with scores,
// since they're attributed to the wrong show anyway. Default (conservative)
// mode only deletes pure junk — no useful data AND no meaningful text.
function shouldDeleteWrongShowBlocker(data, includeScored) {
  if (!data || !data.wrongShow) return false;
  if (includeScored) return true;
  return !hasUsefulWrongShowData(data) && !hasMeaningfulText(data);
}

// Surge guard (mirrors FIX_SURGE_THRESHOLD/--force-bulk pattern from
// clear-stale-suspected-misattribution-flags.js, card #1610): refuses an
// unattended --apply run that would delete an unusually large batch, since
// this writes unattended to the private review-texts corpus weekly.
function shouldRefuseSurge(deleteCount, threshold, forceBulk) {
  return deleteCount > threshold && !forceBulk;
}

module.exports = {
  hasUsefulWrongShowData,
  hasMeaningfulText,
  shouldDeleteWrongShowBlocker,
  shouldRefuseSurge,
};
