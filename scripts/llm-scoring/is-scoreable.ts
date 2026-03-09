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
  // fullTextWrongAuthor: fullText is from wrong author but excerpts may be valid.
  // Scoreable only if there's excerpt content to score from (not fullText).
  if (data.fullTextWrongAuthor) {
    const hasExcerpt = data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || (data as any).nycTheatreExcerpt || (data as any).lboRoundupExcerpt;
    if (!hasExcerpt) return false;
    // Has excerpts — fall through to remaining checks (will be scored from excerpts only)
  }
  // isMultiShowReview is no longer a hard block — the trimmer in index.ts handles these.
  // isRoundupArticle (10+ shows) stays blocked — too many shows for reliable trimming.
  if (data.isRoundupArticle) return false;
  if (data.rejectionReason) return false;
  if (data.showNotMentioned) {
    const hasExcerpt = data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || (data as any).nycTheatreExcerpt || (data as any).lboRoundupExcerpt;
    if (!hasExcerpt) return false;
  }
  return true;
}
