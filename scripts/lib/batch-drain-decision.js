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
 * BRO-7490: "score everything else" must also hold in --batch mode. There is
 * one batch state slot, so while a batch is in flight mayStartNewBatch() refuses
 * every new submission; queueing new reviews behind it scores nothing. On
 * 2026-11-13/14 one slow OpenAI leg left three scheduled runs scoring 0 reviews
 * for ~20h. So an in-flight outcome tells the run to score new work
 * synchronously (the BRO-5047 urgent-show path, same ensemble, full price),
 * capped at SYNC_FALLBACK_MAX_REVIEWS per run: scheduled runs carry no
 * --max-cost and no time budget, and start this after a 120-min poll.
 *
 * @param {Array<{filePath?: string}>} [args.manifest] the in-flight batch's manifest
 * @returns {{holdPaths: string[], skipAllNewWork: boolean, keepState: boolean, scoreNewWorkSync: boolean}}
 */
const SYNC_FALLBACK_MAX_REVIEWS = 60;

function decideDrainFollowUp({ outcome, manifest = [] } = {}) {
  const paths = (Array.isArray(manifest) ? manifest : [])
    .map((m) => m && m.filePath)
    .filter((p) => typeof p === 'string' && p.length > 0);

  switch (outcome) {
    // Results are in (or unrecoverable and discarded). Nothing is locked.
    case 'merged':
    case 'abandoned':
      return { holdPaths: [], skipAllNewWork: false, keepState: false, scoreNewWorkSync: false };

    // A paid vendor leg could not be retrieved. Merging would write a degraded
    // ensemble corpus-wide, so the run parks entirely and retries next time —
    // bounded by decideBatchDrain() above, so it cannot wedge forever. This is
    // the ONE outcome where stopping the whole run is correct.
    case 'refused':
      return { holdPaths: paths, skipAllNewWork: true, keepState: true, scoreNewWorkSync: false };

    // Still in flight: hold only the batch's own files; score everything else,
    // synchronously, because the slot cannot take a second batch (BRO-7490).
    case 'in-flight':
      return { holdPaths: paths, skipAllNewWork: false, keepState: true, scoreNewWorkSync: true };

    default:
      throw new Error(`decideDrainFollowUp: unknown outcome "${outcome}"`);
  }
}

/**
 * May this run submit a NEW vendor batch? (BRO-5047)
 *
 * index.ts keeps a single batch state file. A drain that finds its batch still
 * in flight leaves the state in place and lets the run continue, and the submit
 * block used to write the new batch's state over it: the earlier batch's vendor
 * IDs were lost, so a batch that was already paid for could never be merged.
 * Refusing the submit keeps the paid batch; the queued reviews simply wait for
 * the next run.
 *
 * @param {object|null} existingState readBatchState() at submit time
 * @returns {{allowed: boolean, reason: string|null}}
 */
function mayStartNewBatch(existingState) {
  if (existingState && typeof existingState === 'object') {
    const at = existingState.submittedAt || 'unknown time';
    return { allowed: false, reason: `a batch submitted ${at} is still in flight` };
  }
  return { allowed: true, reason: null };
}

/**
 * Should this review be queued for a batch, scored now, or left for the next
 * run? (BRO-7490) Pure so the loop's branch is tested, not just its inputs.
 *
 * @param {object} a
 * @param {boolean} a.batchMode run started with --batch
 * @param {boolean} a.urgent show is in its opening-night window (BRO-5047: always sync)
 * @param {boolean} a.slotBusy a batch from an earlier run is still in flight
 * @param {number} a.syncFallbackUsed reviews already scored via the fallback this run
 * @param {number} [a.cap] SYNC_FALLBACK_MAX_REVIEWS
 * @returns {'queue'|'sync'|'defer'}
 */
function routeNewReview({ batchMode, urgent, slotBusy, syncFallbackUsed, cap = SYNC_FALLBACK_MAX_REVIEWS }) {
  if (!batchMode || urgent) return 'sync';
  if (!slotBusy) return 'queue';
  return syncFallbackUsed < cap ? 'sync' : 'defer';
}

module.exports = { decideBatchDrain, decideDrainFollowUp, mayStartNewBatch, routeNewReview, SYNC_FALLBACK_MAX_REVIEWS };
