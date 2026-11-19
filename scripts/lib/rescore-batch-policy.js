'use strict';
/**
 * rescore-batch-policy.js — which scoring runs MUST use the vendor Batch APIs
 * (half price) (BRO-7807).
 *
 * memory/api-cost-investigation.md: rescore chains ran synchronously at full
 * price ($40-60/day on gpt-4o) because batch mode was gated on
 * `schedule && !chain`. Rule: a BULK rescore (needs_rescore, outdated,
 * stale_scores, upgrade_ensemble, rescore, or the auto-detected needsRescore
 * backlog) batches on manual dispatch; chain links batch only for
 * needs_rescore (see shouldBatchScoring). Stays synchronous:
 * a run aimed at ONE show (opening-night / press-night, dispatch-rescore.js:
 * latency is the point), the human `sync=true` escape hatch, and any run with
 * a rescore_reason (it gets its own concurrency lane, but the batch state is
 * ONE file, data/collection-state/scoring-batch-state.json, so a second
 * parallel lane would overwrite or poll the first lane's vendor batch IDs).
 * retry_emergency stays synchronous (small, rare).
 * The comparative pass batches exactly when the main pass does, so urgent
 * catch-up runs never wait on it before their commit step.
 *
 * Kill switch (unchanged): repo variable DISABLE_BATCH_SCORING=1.
 */
const on = (v) => v === true || v === 'true' || v === '1' || v === 1;

/** Does this dispatch ask for a rescore (rather than first-time scoring)? */
function isRescoreRun(i = {}) {
  return on(i.needsRescore) || on(i.runRescore) || on(i.rescore) || on(i.outdated)
    || on(i.staleScores) || on(i.upgradeEnsemble);
}

/**
 * Main scoring pass (index.ts). Returns true when `--batch` must be passed.
 * @param {object} i
 * @param {string} i.eventName       github.event_name
 * @param {boolean|string} [i.chain]
 * @param {string} [i.showId]        non-empty = per-show (stays sync)
 * @param {boolean|string} [i.disableBatch]  DISABLE_BATCH_SCORING
 * @param {boolean|string} [i.dryRun]
 * + the rescore flags read by isRescoreRun
 */
function shouldBatchScoring(i = {}) {
  if (on(i.disableBatch)) return false;
  if (on(i.dryRun) || on(i.sync)) return false;
  if (i.showId && String(i.showId).trim()) return false;
  if (i.rescoreReason && String(i.rescoreReason).trim()) return false; // own lane, shared batch-state slot
  if (i.eventName === 'schedule' && !on(i.chain)) return true; // original #516 rule
  // BRO-7807. A chain link that batches and outlasts its poll writes no review
  // files, so the workflow's chain step (has_scored_reviews) stops the chain.
  // Only needs_rescore is resumed afterwards (the cron's cascade + 200/run
  // drain pick the backlog up); an outdated/stale/upgrade/rescore chain would
  // be silently dropped, so those chain links stay sync as before.
  if (on(i.chain)) return on(i.needsRescore) || on(i.runRescore);
  return isRescoreRun(i);
}

/** Comparative within-band rescore (comparative-rescore.ts, gpt-4o leg): same decision as the main pass. */
const shouldBatchComparative = shouldBatchScoring;

module.exports = { isRescoreRun, shouldBatchScoring, shouldBatchComparative };

if (require.main === module) {
  require('./cli-help').exitOnHelp(module);
  const e = process.env;
  const input = {
    eventName: e.EVENT_NAME, chain: e.CHAIN, showId: e.SHOW_ID, disableBatch: e.DISABLE_BATCH_SCORING,
    dryRun: e.DRY_RUN, needsRescore: e.NEEDS_RESCORE, runRescore: e.RUN_RESCORE, rescore: e.RESCORE,
    outdated: e.OUTDATED, staleScores: e.STALE_SCORES, upgradeEnsemble: e.UPGRADE_ENSEMBLE,
    rescoreReason: e.RESCORE_REASON, sync: e.SYNC,
  };
    console.log(String(shouldBatchScoring(input)));
}
