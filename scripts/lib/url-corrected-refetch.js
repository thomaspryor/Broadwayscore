/**
 * URL-corrected refetch selection (BRO-5231).
 *
 * A review whose url was corrected (needsRefetch + urlCorrectedFrom) still holds
 * the body and score of the url it was corrected AWAY from. The collector must
 * refetch it even when that stale body looks complete or already carries a
 * score. The "already has good text" short-circuits in collect-review-texts.js
 * skipped these (439 files on 2026-10-13), so needsRefetch never drained.
 */

function isUrlCorrectedRefetch(data) {
  return !!data && data.needsRefetch === true && !!data.urlCorrectedFrom;
}

/**
 * True when the "complete text" or "scored + reasonable text" short-circuit may
 * skip this review. Never true for a URL-corrected refetch.
 */
function mayShortCircuitCollected(data, { isTruncated, hasGarbageText, datelessDateRetry, scoredSkip, completeSkip }) {
  if (isUrlCorrectedRefetch(data)) {
    // Protected files never clear needsRefetch (the write guard returns early),
    // so bypassing for them would cost a paid fetch on every run.
    return data._locked === true || data.manualContentTier === 'complete'
      ? (completeSkip || scoredSkip)
      : false;
  }
  if (completeSkip && !isTruncated && !hasGarbageText && !datelessDateRetry) return true;
  if (scoredSkip && !isTruncated) return true;
  return false;
}

module.exports = { isUrlCorrectedRefetch, mayShortCircuitCollected };
