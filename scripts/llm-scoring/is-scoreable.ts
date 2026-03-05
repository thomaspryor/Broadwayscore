/**
 * Shared scoreability check for review-text files.
 *
 * A review is "scoreable" if it hasn't been flagged with any data-quality
 * issue that makes LLM scoring impossible or meaningless. This function
 * is the single source of truth — used by the scoring pipeline, flag-setting
 * scripts, and workflow counting steps.
 */
export function isScoreable(data: Record<string, any>): boolean {
  if (data.duplicateOf || data.wrongShow || data.wrongProduction || data.wrongAttribution || data.contentTier === 'invalid') return false;
  if (data.isMultiShowReview || data.isRoundupArticle) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    const hasExcerpt = data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || (data as any).nycTheatreExcerpt;
    if (!hasExcerpt) return false;
  }
  return true;
}
