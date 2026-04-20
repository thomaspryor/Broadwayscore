/**
 * Clear Failure Flags — Pattern Card #1 (Notion 346637c5-416f-8154-9500-f09fd49e5a2a)
 *
 * Failure-state flags persist on disk after the underlying issue is resolved,
 * causing reviews with valid text + scores to be silently excluded from reviews.json.
 *
 * Root cause: scripts write flags on failure paths but nothing systematically
 * clears them on success. `safeWriteReview` with merge:true copies existing
 * field values into any write that doesn't explicitly set them — so even after
 * collect-review-texts.js fetches correct content, a later score-reviews write
 * that doesn't touch `incompleteReason` will copy it back from disk.
 *
 * Fix: call `clearFailureFlags(data)` on every success path BEFORE writing,
 * so the in-memory data has explicit null values rather than missing fields.
 * Combined with removing `incompleteReason`/`incompleteDetail` from
 * PROTECTED_FIELDS (they're derived/descriptive, not irreplaceable scored data),
 * this prevents safeWriteReview from restoring stale flags.
 *
 * Per §15: extracted as a pure function for testability.
 */

/**
 * Success condition: fullText is long enough to represent a real review.
 */
function hasCompletText(data) {
  return !!(data.fullText && typeof data.fullText === 'string' && data.fullText.trim().length >= 500);
}

/**
 * Success condition: review has been scored by LLM ensemble.
 */
function hasLlmScore(data) {
  return !!(data.llmScore && (data.llmScore.score != null || data.llmScore.ensemble));
}

/**
 * Success condition: review has any aggregator signal.
 */
function hasAggregatorSignal(data) {
  return !!(data.aggregatorStars != null || data.originalScore != null || data.assignedScore != null);
}

/**
 * Success condition: URL has been discovered and text has been fetched.
 */
function hasSuccessfulFetch(data) {
  return !!(data.url && data.textFetchedAt);
}

/**
 * Clear stale failure-state flags when success conditions are met.
 *
 * Explicitly sets cleared flags to null (not delete) so that safeWriteReview's
 * merge behavior does not copy the stale value back from disk.
 *
 * Rules:
 * - incompleteReason/incompleteDetail: clear when text is complete (≥500 chars)
 *   OR when there's an aggregator signal (score + excerpt). These are derived
 *   fields — rebuild re-classifies them every run anyway.
 * - rejectionReason/rejectedBy: clear when text is long enough to be a real review
 *   and not obviously garbage. Garbage text should remain flagged.
 * - serpRetryCount/serpDiscoveryAbandoned: clear when URL is successfully discovered.
 *   These prevent infinite SERP loops but must not block reviews after success.
 * - fetchAttempts: informational counter, clear when text is actually fetched.
 *
 * NOT cleared by this function:
 * - wrongShow / wrongProduction — only cleared via explicit nuclear overrides
 * - contentVerification fields — set by LLM verifier, require explicit clearing
 * - humanReview* fields — manual overrides, never auto-clear
 *
 * @param {object} data - Review JSON data (mutated in place)
 * @returns {string[]} List of flags that were cleared
 */
function clearFailureFlags(data) {
  if (!data || typeof data !== 'object') return [];
  const cleared = [];

  const hasText = hasCompletText(data);
  const hasScore = hasLlmScore(data) || hasAggregatorSignal(data);
  const hasFetch = hasSuccessfulFetch(data);

  // incompleteReason/incompleteDetail: clear when content is good
  // These are descriptive metadata re-derived by rebuild — safe to auto-clear
  // when: (a) content tier is complete, OR (b) full text is long enough
  if (data.incompleteReason != null) {
    const contentComplete = data.contentTier === 'complete';
    const textGood = hasText;
    const aggSignal = hasAggregatorSignal(data);
    // Only clear if there's no legitimate reason to keep it:
    // - 'wrong_content': cleared when wrongShow + wrongProduction are both gone AND text is good
    // - 'no_url': cleared when URL is now present
    // - Other reasons: cleared when content tier is complete OR text is good + aggregator signal
    let shouldClear = false;
    if (data.incompleteReason === 'wrong_content') {
      shouldClear = !data.wrongShow && !data.wrongProduction && (contentComplete || textGood);
    } else if (data.incompleteReason === 'no_url') {
      shouldClear = !!data.url;
    } else {
      shouldClear = contentComplete || (textGood && (aggSignal || hasLlmScore(data)));
    }
    if (shouldClear) {
      data.incompleteReason = null;
      data.incompleteDetail = null;
      cleared.push('incompleteReason');
    }
  }

  // rejectionReason/rejectedBy: clear ONLY text-fetch rejections (garbage_text) —
  // semantic rejections (wrong_production, wrong_show, not_a_review) describe content
  // issues that text length does not resolve. Clearing them let a Vulture FILM review
  // of Hamlet (rejected as wrong_production) back into reviews.json (2026-04-20).
  const isTextFetchRejection = data.rejectionReason === 'garbage_text';
  if (data.rejectionReason && hasText && isTextFetchRejection) {
    data.rejectionReason = null;
    cleared.push('rejectionReason');
  }
  if (data.rejectedBy && Array.isArray(data.rejectedBy) && data.rejectedBy.length > 0 && hasText && isTextFetchRejection) {
    // Keep the array but empty it — signals that prior rejection was re-evaluated
    data.rejectedBy = null;
    cleared.push('rejectedBy');
  }

  // SERP retry state: clear when URL has been successfully discovered
  if (data.serpRetryCount != null && data.url) {
    data.serpRetryCount = null;
    cleared.push('serpRetryCount');
  }
  if (data.serpDiscoveryAbandoned === true && data.url && data.fullText) {
    // Only clear serpDiscoveryAbandoned if we actually have content now — URL alone
    // could be a pre-seeded URL that hasn't been verified by SERP
    data.serpDiscoveryAbandoned = null;
    cleared.push('serpDiscoveryAbandoned');
  }

  // fetchAttempts: informational counter — clear when text has been successfully fetched
  if (data.fetchAttempts != null && hasFetch) {
    data.fetchAttempts = null;
    cleared.push('fetchAttempts');
  }

  return cleared;
}

module.exports = {
  clearFailureFlags,
  hasCompletText,
  hasLlmScore,
  hasAggregatorSignal,
  hasSuccessfulFetch,
};
