// BRO-7576: the chain step's budget check. Requires the real functions (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { planChainContinuation, spentInLast24h, loadChainDailyUsd } = require('./scoring-chain-budget.js');
const { rows: REAL } = require('./fixtures/llm-scoring-runs-2026-11-11..13.json');
const CLI = path.join(here, '..', 'scoring-chain-budget.js');

// The 2026-11-12 21:10 needs_rescore chain ("limit 400, max-cost 15"), in order,
// from gh run list. Each batch ~380 reviews at ~$9.3.
const CHAIN = ['43307516610', '43324694092', '43333250542', '43341869110', '43350993139',
  '43359751443', '43367557325', '43375212929'];

const lastCompleted = (runId) => REAL.filter((r) => r.runId === runId)
  .map((r) => r.completedAt).sort().at(-1);
const runCost = (runId) => REAL.filter((r) => r.runId === runId).reduce((s, r) => s + (r.costUsd || 0), 0);

/** Replay the chain step after each batch; returns how many batches would have run. */
function replay({ maxCost, dailyUsd }) {
  let chainSpent = '';
  for (let i = 0; i < CHAIN.length; i++) {
    const now = lastCompleted(CHAIN[i]);
    const runs = REAL.filter((r) => r.completedAt <= now);
    const plan = planChainContinuation({ runs, runId: CHAIN[i], now, maxCost, chainSpent, dailyUsd });
    if (plan.stop) return { ran: i + 1, plan };
    chainSpent = plan.nextChainSpent;
  }
  return { ran: CHAIN.length, plan: null };
}

test('fixture holds every batch of the real chain at ~$9 each', () => {
  for (const id of CHAIN) {
    assert.ok(lastCompleted(id), `missing rows for ${id}`);
    assert.ok(runCost(id) > 8 && runCost(id) < 11, `${id} cost ${runCost(id)}`);
  }
});

test('real 11-12 chain: max_cost=15 now caps the whole chain (stops after the 1st batch, not 8)', () => {
  const { ran, plan } = replay({ maxCost: '15', dailyUsd: null });
  assert.equal(ran, 1);
  assert.match(plan.reason, /^chain-budget:/);
});

test('real 11-12 chain with no max_cost: the daily brake stops it within 2 batches', () => {
  const { ran, plan } = replay({ maxCost: '', dailyUsd: 15 });
  assert.ok(ran <= 2, `ran ${ran}`);
  assert.match(plan.reason, /^daily-brake:/);
  const spent = CHAIN.slice(0, ran).reduce((s, id) => s + runCost(id), 0);
  const all = CHAIN.reduce((s, id) => s + runCost(id), 0);
  assert.ok(all - spent > 50, `avoided only $${(all - spent).toFixed(2)}`);
});

test('chain spend accumulates across batches through chain_spent', () => {
  const runs = [{ runId: '2', costUsd: 4, completedAt: '2026-11-18T10:00:00Z' }];
  const now = '2026-11-18T10:05:00Z';
  const a = planChainContinuation({ runs, runId: '2', now, maxCost: '15', chainSpent: '6.50' });
  assert.equal(a.stop, false);
  assert.equal(a.nextChainSpent, '10.50');
  const b = planChainContinuation({ runs, runId: '2', now, maxCost: '15', chainSpent: '8' });
  assert.equal(b.stop, true, '8 + 4 + next ~4 > 15');
});

test('a normal day lets a chain continue', () => {
  const runs = [
    { runId: 'sched', costUsd: 1.1, completedAt: '2026-11-18T04:40:00Z' },
    { runId: 'c1', costUsd: 9.3, completedAt: '2026-11-18T09:00:00Z' },
  ];
  const p = planChainContinuation({ runs, runId: 'c1', now: '2026-11-18T09:01:00Z', maxCost: '', chainSpent: '', dailyUsd: 15 });
  assert.equal(p.stop, false);
  assert.equal(p.spent24h, 10.4);
});

test('rows older than 24h, unparseable times and bad costs do not count', () => {
  const now = '2026-11-18T12:00:00Z';
  const runs = [
    { runId: 'x', costUsd: 50, completedAt: '2026-11-17T11:59:00Z' },
    { runId: 'x', costUsd: 50, completedAt: 'garbage' },
    { runId: 'x', costUsd: 'NaN', completedAt: '2026-11-18T11:00:00Z' },
    { runId: 'x', costUsd: -5, completedAt: '2026-11-18T11:00:00Z' },
    { runId: 'x', costUsd: 2, completedAt: '2026-11-18T11:30:00Z' },
    null,
  ];
  assert.equal(spentInLast24h(runs, now), 2);
  const none = planChainContinuation({ runs: [], runId: 'r', now, maxCost: '15', dailyUsd: 15 });
  assert.equal(none.stop, true, 'no cost row for this run = unknown spend = stop');
  assert.match(none.reason, /^no-cost-recorded:/);
});

test('the enforcement line is configured and separate from the $10 alarm line', () => {
  assert.equal(typeof loadChainDailyUsd(), 'number');
  assert.ok(loadChainDailyUsd() > 0);
});

function runCli(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env },
  });
}

test('CLI: missing run log stops the chain (fail closed), kill switch lets it through', () => {
  const missing = path.join(os.tmpdir(), `no-such-runs-${process.pid}.json`);
  assert.match(runCli([`--run-id=1`, `--runs-log=${missing}`]), /^stop=true$/m);
  assert.match(runCli([`--run-id=1`, `--runs-log=${missing}`], { SCORING_CHAIN_BUDGET_DISABLED: '1' }), /^stop=false$/m);
});

test('CLI: real chain batch 2 with max_cost=15 answers stop and writes GITHUB_OUTPUT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-budget-'));
  const log = path.join(dir, 'runs.json');
  const out = path.join(dir, 'out');
  const now = lastCompleted(CHAIN[1]);
  fs.writeFileSync(log, JSON.stringify(REAL.filter((r) => r.completedAt <= now)));
  const prior = runCost(CHAIN[0]).toFixed(2);
  const stdout = runCli([`--run-id=${CHAIN[1]}`, '--max-cost=15', `--chain-spent=${prior}`, `--now=${now}`, `--runs-log=${log}`], { GITHUB_OUTPUT: out });
  assert.match(stdout, /^stop=true$/m);
  assert.match(fs.readFileSync(out, 'utf8'), /^reason=chain-budget:/m);
});

test('llm-ensemble-score.yml Chain next batch step runs the budget check before dispatching', () => {
  const yml = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'llm-ensemble-score.yml'), 'utf8');
  const start = yml.indexOf('- name: Chain next batch');
  assert.ok(start > 0, 'Chain next batch step not found');
  const end = yml.indexOf('\n      - name:', start + 10);
  const step = yml.slice(start, end > 0 ? end : undefined);
  const check = step.indexOf('node scripts/scoring-chain-budget.js');
  const dispatch = step.indexOf('gh workflow run llm-ensemble-score.yml');
  assert.ok(check > 0, 'budget check missing from the chain step');
  assert.ok(dispatch > check, 'budget check must run before the next batch is dispatched');
  assert.match(step, /grep -qx 'stop=true'[\s\S]*exit 0/, 'a stop answer must end the step');
  assert.match(step, /-f chain_spent_usd=/, 'chain spend must be carried to the next batch');
  assert.match(yml, /^      chain_spent_usd:$/m, 'chain_spent_usd input missing');
});

test('a budgeted chain (max_cost set) answers only to its cap, not the daily brake', () => {
  const runs = [
    { runId: 'other', costUsd: 30, completedAt: '2026-11-18T08:00:00Z' },
    { runId: 'c1', costUsd: 2, completedAt: '2026-11-18T09:00:00Z' },
  ];
  const p = planChainContinuation({ runs, runId: 'c1', now: '2026-11-18T09:01:00Z', maxCost: '50', chainSpent: '', dailyUsd: 15 });
  assert.equal(p.stop, false);
});

test('a garbled chain_spent or max_cost is an error, never $0', () => {
  const now = '2026-11-18T09:01:00Z';
  assert.throws(() => planChainContinuation({ runs: [], runId: 'r', now, maxCost: '15', chainSpent: 'abc' }), /chain_spent_usd/);
  assert.throws(() => planChainContinuation({ runs: [], runId: 'r', now, maxCost: '-3' }), /max_cost/);
});

test('CLI: kill switch keeps counting chain spend', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-budget-'));
  const log = path.join(dir, 'runs.json');
  fs.writeFileSync(log, JSON.stringify([{ runId: '7', costUsd: 9, completedAt: '2026-11-18T09:00:00Z' }]));
  const out = runCli(['--run-id=7', '--max-cost=15', '--chain-spent=9', '--now=2026-11-18T09:01:00Z', `--runs-log=${log}`], { SCORING_CHAIN_BUDGET_DISABLED: '1' });
  assert.match(out, /^stop=false$/m);
  assert.match(out, /^chain_spent=18\.00$/m);
});

test('Build CLI args gives a chained batch only what is left of max_cost', () => {
  const yml = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'llm-ensemble-score.yml'), 'utf8');
  assert.match(yml, /INPUT_CHAIN_SPENT_USD: \$\{\{ github\.event\.inputs\.chain_spent_usd \}\}/);
  assert.match(yml, /MAX_COST=\$\(awk -v c="\$MAX_COST" -v s="\$\{INPUT_CHAIN_SPENT_USD:-\}"/);
});

test('run-name carries chain spend and express-preemption restores it', () => {
  const yml = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'llm-ensemble-score.yml'), 'utf8');
  assert.match(yml.split('\n')[3], /inputs\.chain_spent_usd && ', spent '/);
  const { planRedispatch, SCORING } = require('./express-preemption.js');
  const p = planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 3 left, limit 400, max-cost 15, spent 9.30)');
  assert.equal(p.fields.chain_spent_usd, '9.30');
  assert.equal(p.fields.max_cost, '15');
  assert.equal(planRedispatch(SCORING, 'LLM Ensemble Score Reviews (rescore chain, 3 left, limit 400, max-cost 15)').fields.chain_spent_usd, undefined);
});
