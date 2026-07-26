/**
 * rescore-lifecycle.js — single source of truth for retiring a needsRescore flag.
 *
 * WHY THIS EXISTS (2026-07-26 incident):
 * scripts/llm-scoring/index.ts had TWO success paths that persist a score:
 *   1. the main ensemble path (cleared needsRescore)
 *   2. the manually-cleared Haiku fallback path (did NOT — it saved and
 *      `return true`d before reaching the clear at the main path)
 * Any file that scored via path 2 kept `needsRescore: true` forever, so every
 * subsequent drain re-scored it: unbounded 3-model API spend on already-done
 * work, and a queue count that never decreases. The NYC-rollout
 * bw-v6-decompression queue sat at exactly 141 across repeated drains for
 * ~6 days because of this; 10 of those files had a fresh score on disk while
 * still flagged.
 *
 * The fix is structural, not a second copy of the clearing code: every path
 * that persists a score calls markRescoreComplete(). A new success path added
 * later is one call away from correct, and rescore-lifecycle.test.mjs asserts
 * that no scoring success path in index.ts writes a file without it.
 *
 * Cross-ref: memory/feedback_test_extraction_pattern.md (pure decision function
 * in scripts/lib/, required by both production and test).
 */

/**
 * Retire the rescore queue entry on a scored review file.
 *
 * Mutates in place and returns the same object so callers can inline it into a
 * save: saveReviewFile(path, markRescoreComplete(scoredAny)).
 *
 * `rescoreReason` is deliberately PRESERVED — it is the historical record of
 * why the file was requeued (audits group by it, e.g. bw-v6-decompression).
 * Only the actionable `needsRescore` flag is cleared, plus a completion stamp
 * so a stale-queue auditor can tell "done" from "never attempted".
 *
 * @param {Object} fileData - review file object about to be persisted
 * @param {string} [completedAt] - ISO timestamp; defaults to now (injectable for tests)
 * @returns {Object} the same fileData, mutated
 */
function markRescoreComplete(fileData, completedAt) {
  if (!fileData || typeof fileData !== 'object') return fileData;
  // Both spellings appear in the corpus (snake_case from older sweeps).
  if (fileData.needsRescore || fileData.needs_rescore) {
    delete fileData.needsRescore;
    delete fileData.needs_rescore;
    fileData.rescoreCompletedAt = completedAt || new Date().toISOString();
  }
  return fileData;
}

/**
 * Detect the stuck state this module exists to prevent: a file still queued for
 * rescore that already carries a score newer than the queue entry. True means
 * a success path persisted a score without calling markRescoreComplete() — the
 * file will be re-scored on every drain until someone clears it.
 *
 * Used by scripts/audit-stale-rescore-queue.js (CI gate) so a future
 * regression surfaces as a failing check instead of a silent API-spend leak.
 *
 * @param {Object} fileData
 * @returns {boolean}
 */
function isStuckInRescoreQueue(fileData) {
  if (!fileData || typeof fileData !== 'object') return false;
  if (!(fileData.needsRescore || fileData.needs_rescore)) return false;
  const scoredAt = fileData.llmMetadata?.scoredAt || fileData.scoredAt;
  if (!scoredAt) return false;
  const flaggedAt = fileData.rescoreFlaggedAt || fileData.needsRescoreAt;
  // No flag timestamp recorded: fall back to "has a score at all while queued",
  // which is the observable symptom the incident presented with.
  if (!flaggedAt) return true;
  return String(scoredAt) > String(flaggedAt);
}

module.exports = { markRescoreComplete, isStuckInRescoreQueue };
