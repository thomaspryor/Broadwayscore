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

/**
 * Decide what a drain's outcome means for the REST of the run.
 *
 * decideBatchDrain() above answers "what should this drain do with the batch?".
 * This answers the separate question the 2026-08-31 review surfaced: "what may
 * the run still score afterwards?"
 *
 * The bug it encodes against: a batch that was merely STILL IN FLIGHT set
 * `skipNewWork = true` in index.ts, and the scoring loop is guarded by
 * `!skipNewWork && i < finalFiles.length` — so ONE in-flight batch stopped the
 * run scoring anything at all, including reviews for completely unrelated
 * shows. The run then exited 0 having scored nothing, and because the
 * opening-night gate reads score_total === 0 as "nothing to do", the pipeline
 * went GREEN. A loud false failure traded for a silent true one, during
 * opening night — the one moment the whole pipeline exists for.
 *
 * The distinction that matters: only the batch's OWN files are unsafe to score
 * synchronously (double-paying the vendor and racing the eventual merge).
 *
 * @param {object} args
 * @param {'merged'|'abandoned'|'refused'|'in-flight'} args.outcome
 * @param {Array<{filePath?: string}>} [args.manifest] the in-flight batch's manifest
 * @returns {{holdPaths: string[], skipAllNewWork: boolean, keepState: boolean}}
 */
function decideDrainFollowUp({ outcome, manifest = [] } = {}) {
  const paths = (Array.isArray(manifest) ? manifest : [])
    .map((m) => m && m.filePath)
    .filter((p) => typeof p === 'string' && p.length > 0);

  switch (outcome) {
    // Results are in (or unrecoverable and discarded). Nothing is locked.
    case 'merged':
    case 'abandoned':
      return { holdPaths: [], skipAllNewWork: false, keepState: false };

    // A paid vendor leg could not be retrieved. Merging would write a degraded
    // ensemble corpus-wide, so the run parks entirely and retries next time —
    // bounded by decideBatchDrain() above, so it cannot wedge forever. This is
    // the ONE outcome where stopping the whole run is correct.
    case 'refused':
      return { holdPaths: paths, skipAllNewWork: true, keepState: true };

    // Still in flight: hold only the batch's own files; score everything else.
    case 'in-flight':
      return { holdPaths: paths, skipAllNewWork: false, keepState: true };

    default:
      throw new Error(`decideDrainFollowUp: unknown outcome "${outcome}"`);
  }
}

module.exports = { decideBatchDrain, decideDrainFollowUp };
