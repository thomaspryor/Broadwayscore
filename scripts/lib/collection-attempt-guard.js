/**
 * Single source of truth for "has this review already been attempted in the
 * current collect-review-texts.js session?" (BRO-3024).
 *
 * Before this existed, only the review-selection loop in
 * findReviewsToProcess() checked state.processed/state.failed before adding
 * a review to the work queue. The per-attempt loop in main() that actually
 * calls processReview() and pushes to state.failed had no equivalent check,
 * so a review already recorded as failed/processed earlier in the same
 * session could still be re-attempted, burning a paid fetch (Browserbase/
 * Bright Data/ScrapingBee) for nothing.
 */
function shouldSkipAlreadyAttempted(state, reviewId, retryFailed = false) {
  if (state.processed.includes(reviewId)) return true;
  if (!retryFailed && state.failed.includes(reviewId)) return true;
  return false;
}

/**
 * Collapse state.failed / state.processed to unique reviewIds, preserving
 * first-seen order (BRO-3024, owner re-verification 2026-09-14).
 *
 * shouldSkipAlreadyAttempted above is an IN-PROCESS guard and cannot be the
 * whole fix, because two live mechanisms defeat it — both measured, not
 * theorised:
 *
 *   (A) RETRY MODE. opening-night-poller.yml sets RETRY_FAILED: 'true', and
 *       the guard deliberately returns false for state.failed when
 *       retryFailed is set (retrying failures is intended behaviour). Every
 *       retry therefore re-appends the same reviewId.
 *
 *   (B) CONCURRENT RUNS. opening-night-poller.yml uses a PER-SHOW concurrency
 *       group, so runs for different shows execute in parallel against the
 *       SAME data/collection-state/progress.json. Each loadState()s, builds
 *       its own queue, appends, and saveState()s last-writer-wins. No
 *       in-process guard can see another process's appends.
 *
 * On a post-fix run (progress.json startTime 2026-09-14T00:45:52.847Z, six
 * days after the in-process guard landed in 326602a0342) state.failed still
 * carried 291 unique ids and 87 duplicate entries, with six overlapping
 * opening-night-poller runs in that window.
 *
 * Deduping at the WRITE (and normalising on load) is idempotent under both
 * mechanisms: whichever run serialises last writes a unique-only array. It
 * also makes the "(N failed)" figure in every "chore: Checkpoint" commit
 * message count failed URLs rather than attempts — that number was inflated
 * ~2x and the whole fleet reads it as a failure count.
 *
 * Mutates `state` in place and returns a summary of what it removed, so
 * callers can log it. Missing/non-array fields are left alone rather than
 * invented, so an older or partial state file is not reshaped by a save.
 */
function dedupeAttemptState(state) {
  const removed = { processed: 0, failed: 0 };
  if (!state || typeof state !== 'object') return removed;
  for (const key of ['processed', 'failed']) {
    const arr = state[key];
    if (!Array.isArray(arr)) continue;
    const unique = [...new Set(arr)];
    removed[key] = arr.length - unique.length;
    if (removed[key] > 0) state[key] = unique;
  }
  return removed;
}

module.exports = { shouldSkipAlreadyAttempted, dedupeAttemptState };
