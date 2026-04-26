/**
 * Shared scoreability check for review-text files.
 *
 * A review is "scoreable" if it hasn't been flagged with any data-quality
 * issue that makes LLM scoring impossible or meaningless. This function
 * is the single source of truth — used by the scoring pipeline, flag-setting
 * scripts, and workflow counting steps.
 */

// Canonical excerpt field list — single source of truth in excerpt-fields.js
const { hasExcerpt: hasAnyExcerpt } = require('../lib/excerpt-fields');
const { isLikelyStaleRoundupFlag, isLikelyStaleWrongShow, wrongShowCleared } = require('../lib/review-guards');

export function isScoreable(data: Record<string, any>, show?: Record<string, any>): boolean {
  if (data.duplicateOf || data.wrongProduction || data.wrongAttribution || data.contentTier === 'invalid') return false;
  // wrongShow: same manual-clear + stale-override semantics as isIncludableForRebuild
  // (Notion 34e637c5-416f-8121). Without the override, a human-cleared file
  // could pass rebuild but be skipped by the LLM rescore — leaving it scoreless.
  if (data.wrongShow && !wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show)) return false;
  if (data.incompleteReason === 'scraper_garbage') return false;
  // fullTextWrongAuthor: fullText is from wrong author but excerpts may be valid.
  // Scoreable only if there's excerpt content to score from (not fullText).
  if (data.fullTextWrongAuthor) {
    if (!hasAnyExcerpt(data)) return false;
    // Has excerpts — fall through to remaining checks (will be scored from excerpts only)
  }
  // isMultiShowReview is no longer a hard block — the trimmer in index.ts handles these.
  // isRoundupArticle (10+ shows) stays blocked — too many shows for reliable trimming.
  // Defensive override: stale flag on a substantial individual review — Notion 34e637c5.
  if (data.isRoundupArticle && !isLikelyStaleRoundupFlag(data)) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    if (!hasAnyExcerpt(data)) return false;
  }
  return true;
}
