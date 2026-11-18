'use strict';

/**
 * BRO-7576: budget check for llm-ensemble-score.yml's "Chain next batch" step.
 *
 * Root cause of the recurring "LLM scoring daily spend over budget" alarm
 * (BRO-6062, BRO-6317, BRO-6732, BRO-7685): a self-chaining rescore ran batch
 * after batch with nothing tracking what the chain had spent. The step passed
 * the same max_cost to every batch and its comment said that made the cap
 * "apply across the whole chain", but --max-cost is per process: on
 * 2026-11-12/13 two "limit 400, max-cost 15" chains ran ~11 batches at ~$9.3
 * each ($47.62 and $63.60 days vs the $10 line) and never tripped it.
 *
 * Two rules, checked before the next batch is dispatched:
 *  1. Chain cap: chain_spent_usd carries what earlier batches spent. Stop when
 *     the next batch, estimated at this batch's cost, would take the chain
 *     past max_cost. max_cost itself is left unchanged on purpose: the
 *     run-name prints it and express-preemption.js keys chains on it.
 *     The scorer also gets only the rest of the cap as its own --max-cost
 *     (llm-ensemble-score.yml Build CLI args), so a dearer batch is cut off.
 *  2. Daily brake, for chains with no max_cost (schedule, rebuild catch-up,
 *     unbudgeted dispatches): stop when scoring spend completed in the last
 *     24h has reached llmScoringChainDailyUsd. Scheduled runs re-detect
 *     needsRescore / stale / emergency work; a manual outdated or
 *     upgrade_ensemble chain must be re-dispatched (the step warns).
 *     A chain dispatched with max_cost has a budget, so only rule 1 applies.
 * Only chains reach this step; urgent per-show scoring (dispatch-rescore.js,
 * show_id, no chain) never does.
 */

const fs = require('fs');
const {
  DEFAULT_RUNS_LOG_PATH,
  DEFAULT_THRESHOLDS_PATH,
  sumCostUsdForRun,
  loadCostThresholdUsd,
} = require('./llm-scoring-cost-recording');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAIN_DAILY_KEY = 'llmScoringChainDailyUsd';

function toUsd(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Like toUsd, but a value that is present and not a USD amount is an error, never $0. */
function strictUsd(v, name) {
  const n = toUsd(v);
  if (n === null && !(v === null || v === undefined || v === '')) throw new Error(`${name} is not a USD amount: ${v}`);
  return n;
}

function costOf(r) {
  return r && typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0;
}

/** Scoring spend of runs completed in the 24h before `now`. */
function spentInLast24h(runs, now) {
  const end = new Date(now).getTime();
  return (Array.isArray(runs) ? runs : []).reduce((sum, r) => {
    const t = Date.parse(r?.completedAt);
    return t > end - DAY_MS && t <= end ? sum + costOf(r) : sum;
  }, 0);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pure decision. Returns { stop, reason, nextChainSpent, spentThisRun, spent24h }.
 * `nextChainSpent` (string, 2dp) is what the next batch gets as chain_spent_usd.
 */
function planChainContinuation({ runs, runId, now = new Date(), maxCost, chainSpent, dailyUsd } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const spentThisRun = round2(sumCostUsdForRun(list, String(runId ?? '')));
  const prior = strictUsd(chainSpent, 'chain_spent_usd') ?? 0;
  const total = round2(prior + spentThisRun);
  const spent24h = round2(spentInLast24h(list, now));
  const cap = strictUsd(maxCost, 'max_cost');
  const line = toUsd(dailyUsd);
  const base = { nextChainSpent: total.toFixed(2), spentThisRun, spent24h };

  // The chain step runs only after this batch scored reviews, which always
  // costs money: no cost row for this run means its spend is unknown, not $0.
  if (spentThisRun <= 0) {
    return { ...base, stop: true, reason: `no-cost-recorded: no costUsd for run ${runId} in the run log, so the chain's spend is unknown` };
  }

  if (cap !== null && cap > 0 && total + spentThisRun > cap) {
    return {
      ...base, stop: true,
      reason: `chain-budget: chain spent $${total.toFixed(2)} of max_cost $${cap}; the next batch (~$${spentThisRun.toFixed(2)}) would pass it`,
    };
  }
  if (cap === null && line !== null && line > 0 && spent24h >= line) {
    return {
      ...base, stop: true,
      reason: `daily-brake: LLM scoring spent $${spent24h.toFixed(2)} in the last 24h, at or over the $${line} ${CHAIN_DAILY_KEY} line; scheduled runs pick up needsRescore/stale work, re-dispatch a manual outdated/upgrade chain with max_cost to go on`,
    };
  }
  return {
    ...base, stop: false,
    reason: `ok: chain spent $${total.toFixed(2)}${cap ? ` of $${cap}` : ''}, last 24h $${spent24h.toFixed(2)}${line ? ` of $${line}` : ''}`,
  };
}

function readRuns(runsLogPath = DEFAULT_RUNS_LOG_PATH) {
  const parsed = JSON.parse(fs.readFileSync(runsLogPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${runsLogPath} is not an array`);
  return parsed;
}

module.exports = {
  CHAIN_DAILY_KEY,
  planChainContinuation,
  spentInLast24h,
  readRuns,
  loadChainDailyUsd: (p = DEFAULT_THRESHOLDS_PATH) => loadCostThresholdUsd(p, CHAIN_DAILY_KEY),
};
