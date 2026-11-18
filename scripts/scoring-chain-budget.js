#!/usr/bin/env node
'use strict';

/**
 * BRO-7576: should llm-ensemble-score.yml dispatch the next chained batch?
 * Rules: scripts/lib/scoring-chain-budget.js.
 *
 *   node scripts/scoring-chain-budget.js --run-id=<GITHUB_RUN_ID> [--max-cost=15] [--chain-spent=9.30]
 *     [--now=<ISO>] [--runs-log=data/llm-scoring-runs.json]
 *
 * Writes stop=true|false, chain_spent=<usd>, reason=<text> to $GITHUB_OUTPUT
 * (or stdout). Exits 0 either way. Any error decides stop=true: the backlog
 * then waits for the scheduled batch runs, which is cheaper than an
 * unmetered chain. Kill switch: SCORING_CHAIN_BUDGET_DISABLED=1.
 */

const fs = require('fs');
const { planChainContinuation, readRuns, loadChainDailyUsd } = require('./lib/scoring-chain-budget');
const { DEFAULT_RUNS_LOG_PATH } = require('./lib/llm-scoring-cost-recording');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function emit(out) {
  const reason = String(out.reason).replace(/[\r\n]+/g, ' ');
  const lines = `stop=${out.stop}\nchain_spent=${out.chainSpent}\nreason=${reason}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}

function main() {
  const prior = arg('chain-spent') || '0';
  if (process.env.SCORING_CHAIN_BUDGET_DISABLED === '1') {
    emit({ stop: false, chainSpent: prior, reason: 'SCORING_CHAIN_BUDGET_DISABLED=1, budget check skipped' });
    return;
  }
  try {
    const runId = arg('run-id') || process.env.GITHUB_RUN_ID;
    if (!runId) throw new Error('no --run-id and no GITHUB_RUN_ID');
    const nowArg = arg('now');
    const now = nowArg ? new Date(nowArg) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error(`bad --now ${nowArg}`);
    const runs = readRuns(arg('runs-log') || DEFAULT_RUNS_LOG_PATH);
    const plan = planChainContinuation({
      runs, runId, now,
      maxCost: arg('max-cost'),
      chainSpent: prior,
      dailyUsd: loadChainDailyUsd(),
    });
    emit({ stop: plan.stop, chainSpent: plan.nextChainSpent, reason: plan.reason });
  } catch (e) {
    emit({ stop: true, chainSpent: prior, reason: `budget check failed (${e.message}); chain stopped, scheduled batch runs pick up the rest` });
  }
}

main();
