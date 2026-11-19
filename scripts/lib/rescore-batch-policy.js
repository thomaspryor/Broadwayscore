'use strict';
/**
 * rescore-batch-policy.js — which scoring runs MUST use the vendor Batch APIs
 * (half price) (BRO-7807).
 *
 * memory/api-cost-investigation.md: rescore chains ran synchronously at full
 * price ($40-60/day on gpt-4o) because batch mode was gated on
 * `schedule && !chain`. Rule: a BULK rescore (needs_rescore, outdated,
 * stale_scores, upgrade_ensemble, rescore, a rescore_reason bucket, or the
 * auto-detected needsRescore backlog) always batches, scheduled or not, chain
 * or not. Only a run aimed at ONE show stays synchronous (opening-night /
 * press-night per-show dispatches, dispatch-rescore.js): there the latency is
 * the point.
 *
 * Kill switch (unchanged): repo variable DISABLE_BATCH_SCORING=1.
 */
const on = (v) => v === true || v === 'true' || v === '1' || v === 1;

/** Does this dispatch ask for a rescore (rather than first-time scoring)? */
function isRescoreRun(i = {}) {
  return on(i.needsRescore) || on(i.runRescore) || on(i.rescore) || on(i.outdated)
    || on(i.staleScores) || on(i.upgradeEnsemble) || !!(i.rescoreReason && String(i.rescoreReason).trim());
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
  if (on(i.dryRun)) return false;
  const showId = i.showId && String(i.showId).trim();
  if (showId) return false;
  if (i.eventName === 'schedule' && !on(i.chain)) return true; // original #516 rule
  return isRescoreRun(i);                                      // BRO-7807: bulk rescore, chain or dispatch
}

/**
 * Comparative within-band rescore (comparative-rescore.ts, gpt-4o leg). Every
 * run that is not aimed at a single show batches, chain included.
 */
function shouldBatchComparative(i = {}) {
  if (on(i.disableBatch)) return false;
  if (on(i.dryRun)) return false;
  return !(i.showId && String(i.showId).trim());
}

module.exports = { isRescoreRun, shouldBatchScoring, shouldBatchComparative };

if (require.main === module) {
  require('./cli-help').exitOnHelp(module);
  const e = process.env;
  const input = {
    eventName: e.EVENT_NAME, chain: e.CHAIN, showId: e.SHOW_ID, disableBatch: e.DISABLE_BATCH_SCORING,
    dryRun: e.DRY_RUN, needsRescore: e.NEEDS_RESCORE, runRescore: e.RUN_RESCORE, rescore: e.RESCORE,
    outdated: e.OUTDATED, staleScores: e.STALE_SCORES, upgradeEnsemble: e.UPGRADE_ENSEMBLE,
    rescoreReason: e.RESCORE_REASON,
  };
  const which = process.argv[2] === 'comparative' ? shouldBatchComparative : shouldBatchScoring;
  console.log(String(which(input)));
}
