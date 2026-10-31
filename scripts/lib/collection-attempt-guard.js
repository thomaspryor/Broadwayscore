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
 * Deduping at the WRITE (and normalising on load) makes the persisted arrays
 * duplicate-free under both mechanisms: whichever run serialises last writes
 * a unique-only array.
 *
 * SCOPE, precisely — this fixes DUPLICATION, not concurrency. Mechanism (B)
 * has a second half this does NOT address: last-writer-wins also DISCARDS the
 * other run's ids. That loss is deliberate elsewhere in the stack —
 * push-with-retry.sh's `data/collection-state/*` conflict arm resolves
 * "keep the local run's data", whole-file ours-wins, because progress.json is
 * per-run scratch rather than a union ledger. Do not read this function as
 * "concurrency is handled".
 *
 * It ALSO drops any id that is in `failed` but has since succeeded into
 * `processed`. Under RETRY_FAILED=true a review can legitimately fail and
 * then succeed within the same state file, landing in both arrays — leaving
 * the stale entry keeps the "(N failed)" figure in every "chore: Checkpoint"
 * commit message, and the success-rate denominator, counting a URL that is no
 * longer failed. `processed` is authoritative: shouldSkipAlreadyAttempted
 * checks it first and unconditionally, and real retry scheduling lives in
 * data/review-texts/failed-fetches.json (failureCount / shouldRetryFetch,
 * BRO-787), never in state.failed.
 *
 * Mutates `state` in place and returns a summary of what it removed, so
 * callers can log it. Missing/non-array fields are left alone rather than
 * invented, so an older or partial state file is not reshaped by a save.
 */
function dedupeAttemptState(state) {
  const removed = { processed: 0, failed: 0, succeededAfterFailure: 0, tierBreakdown: 0 };
  if (!state || typeof state !== 'object') return removed;
  for (const key of ['processed', 'failed']) {
    const arr = state[key];
    if (!Array.isArray(arr)) continue;
    const unique = [...new Set(arr)];
    removed[key] = arr.length - unique.length;
    if (removed[key] > 0) state[key] = unique;
  }
  // tierBreakdown arrays are appended per success from the same loop and are
  // duplicated by the same two mechanisms, so the "[PW:48,BB:3,BD:9]" figures
  // in each checkpoint commit message inflate exactly as "(N failed)" did.
  // Normalising them here keeps every count in one commit message consistent
  // with every other — otherwise the first resume after this ships prints
  // shrunken processed/failed next to un-shrunken tier counts.
  if (state.tierBreakdown && typeof state.tierBreakdown === 'object') {
    for (const [tier, arr] of Object.entries(state.tierBreakdown)) {
      if (!Array.isArray(arr)) continue;
      const unique = [...new Set(arr)];
      if (unique.length !== arr.length) {
        removed.tierBreakdown += arr.length - unique.length;
        state.tierBreakdown[tier] = unique;
      }
    }
  }

  if (Array.isArray(state.failed) && Array.isArray(state.processed)) {
    const succeeded = new Set(state.processed);
    const stillFailed = state.failed.filter((id) => !succeeded.has(id));
    removed.succeededAfterFailure = state.failed.length - stillFailed.length;
    if (removed.succeededAfterFailure > 0) {
      // MOVE, don't delete. Purging these ids from `failed` is what makes the
      // "(N failed)" count truthful, but it would also erase the only record
      // that the id ever failed: clearFailedFetch() already removes its
      // failed-fetches.json entry on success, and failuresByOutlet is
      // outlet-keyed rather than id-keyed. Without this an operator asking
      // "which URLs are flaky?" would see a clean report for a review that
      // timed out twice before landing. Keeping them in their own array costs
      // nothing and preserves the per-id history.
      const recovered = new Set(Array.isArray(state.recoveredAfterFailure) ? state.recoveredAfterFailure : []);
      for (const id of state.failed) if (succeeded.has(id)) recovered.add(id);
      state.recoveredAfterFailure = [...recovered];
      state.failed = stillFailed;
    }
  }
  return removed;
}

module.exports = { shouldSkipAlreadyAttempted, dedupeAttemptState };
