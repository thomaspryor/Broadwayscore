/**
 * Decide what a batch drain should do when a paid vendor leg could not be
 * retrieved.
 *
 * Background (2026-08-29 incident): processBatchResults() refuses to merge
 * whenever any submitted vendor leg is unretrievable, because merging a
 * 2-of-3 ensemble corpus-wide off a transient 429 would be far worse than
 * waiting. It kept the state and retried on the next run — correct for a
 * transient failure, fatal for a permanent one. OpenAI batch
 * batch_6a92c58189c88190a81297b49683df73 went terminal with neither an
 * output nor an error file, so the fetch could never succeed; every later
 * run re-drained the same dead batch and exited 2, failing the opening-night
 * poller's stage verification 7 runs in a row. The only escape was the 48h
 * BATCH_STATE_MAX_AGE_HOURS gate — ~35h away at the time, and already
 * inconsistent with vendors expiring batches at 24h.
 *
 * Bounding the retries fixes both cases: a transient blip clears within a
 * run or two, and a permanently dead batch is abandoned instead of wedging
 * the pipeline.
 *
 * @param {object} opts
 * @param {string[]} opts.unretrievableVendors Vendor legs whose results could
 *   not be retrieved. Empty means the drain can merge.
 * @param {number} [opts.drainCount] Consecutive refused drains so far (from
 *   BatchState.unretrievableDrainCount; absent/0 on a fresh batch).
 * @param {number} [opts.maxDrains] Abandon once this many consecutive drains
 *   have refused.
 * @returns {{action: 'merge'|'retry'|'abandon', attempt: number}}
 *   `attempt` is this drain's 1-based refusal number (0 when merging).
 */
function decideBatchDrain({ unretrievableVendors, drainCount = 0, maxDrains = 3 } = {}) {
  const unretrievable = Array.isArray(unretrievableVendors) ? unretrievableVendors : [];
  if (unretrievable.length === 0) return { action: 'merge', attempt: 0 };

  // A negative/NaN stored count must not extend the wedge past the bound.
  const prior = Number.isFinite(drainCount) && drainCount > 0 ? Math.floor(drainCount) : 0;
  const attempt = prior + 1;
  const bound = Number.isFinite(maxDrains) && maxDrains >= 1 ? Math.floor(maxDrains) : 1;

  return { action: attempt >= bound ? 'abandon' : 'retry', attempt };
}

module.exports = { decideBatchDrain };
