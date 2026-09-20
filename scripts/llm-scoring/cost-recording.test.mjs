// BRO-3381 — LLM scoring cost is computed every run and thrown away. This
// pins the fix: costUsd gets persisted onto each run summary and a run
// summing above the configured threshold produces a real, never-silenced
// alert conditionKey.
//
// require('ts-node/register') below matches scripts/llm-scoring/batch-mode.
// test.mjs's pattern — it lets this plain `node --test` file require() the
// real cost.ts (TypeScript) module regardless of the Node version running
// it, instead of copying its pricing math into the test (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register');

const { costBreakdown } = require('./cost');
const {
  appendRunSummary,
  sumCostUsdForRun,
  loadCostThresholdUsd,
  checkCostBreach,
  COST_BREACH_CONDITION_KEY,
} = require('../lib/llm-scoring-cost-recording.js');
const { isNeverQuietCondition } = require('../lib/owner-alert-router.js');

function tmpRunsLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-scoring-cost-recording-test-'));
  return path.join(dir, 'llm-scoring-runs.json');
}

const SAMPLE_USAGE = {
  claude: { input: 200_000, output: 50_000, cacheWrite: 10_000, cacheRead: 5_000 },
  openai: { input: 150_000, output: 40_000 },
  gemini: { input: 80_000, output: 20_000 },
};

test('appendRunSummary records costUsd equal to cost.ts costBreakdown() for the same token counts', () => {
  const runsLogPath = tmpRunsLogPath();
  const expected = costBreakdown(SAMPLE_USAGE, { claudeModelName: 'claude-sonnet', batch: false }).total;
  assert.ok(expected > 0, 'sanity: sample usage must price to a non-zero cost');

  const summary = {
    startedAt: '2026-09-15T00:00:00.000Z',
    completedAt: '2026-09-15T00:05:00.000Z',
    totalReviews: 10,
    processed: 10,
    skipped: 0,
    errors: 0,
    tokensUsed: { input: 430_000, output: 110_000, total: 540_000 },
    costUsd: expected,
    runId: 'gh-run-1',
    errorDetails: [],
  };

  const runs = appendRunSummary(summary, { runsLogPath });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].costUsd, expected);

  const onDisk = JSON.parse(fs.readFileSync(runsLogPath, 'utf-8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].costUsd, expected);
});

test('appendRunSummary caps the log at the last 100 entries', () => {
  const runsLogPath = tmpRunsLogPath();
  let runs;
  for (let i = 0; i < 105; i++) {
    runs = appendRunSummary({ startedAt: 'x', completedAt: 'x', totalReviews: 0, processed: 0, skipped: 0, errors: 0, tokensUsed: { input: 0, output: 0, total: 0 }, costUsd: i, runId: null, errorDetails: [] }, { runsLogPath });
  }
  assert.equal(runs.length, 100);
  assert.equal(runs[0].costUsd, 5, 'oldest 5 entries should have been dropped');
  assert.equal(runs[99].costUsd, 104);
});

test('sumCostUsdForRun sums only entries matching the given runId', () => {
  const runs = [
    { runId: 'run-a', costUsd: 1.5 },
    { runId: 'run-a', costUsd: 2.5 },
    { runId: 'run-b', costUsd: 100 },
    { runId: null, costUsd: 9 },
  ];
  assert.equal(sumCostUsdForRun(runs, 'run-a'), 4);
  assert.equal(sumCostUsdForRun(runs, 'run-b'), 100);
  assert.equal(sumCostUsdForRun(runs, 'run-c'), 0);
});

test('loadCostThresholdUsd reads the real llmScoringRunUsd line from provider-spend-thresholds.json', () => {
  const threshold = loadCostThresholdUsd();
  assert.equal(typeof threshold, 'number');
  assert.ok(threshold > 0);
});

test('checkCostBreach: a run summing above the threshold breaches, with a conditionKey the digest can never silence', () => {
  const runs = [
    { runId: 'gh-run-9', costUsd: 4 },
    { runId: 'gh-run-9', costUsd: 3 },
    { runId: 'gh-run-9-other', costUsd: 999 }, // must not leak into gh-run-9's sum
  ];
  const breach = checkCostBreach(runs, { runId: 'gh-run-9', thresholdUsd: 6 });
  assert.ok(breach);
  assert.equal(breach.totalUsd, 7);
  assert.equal(breach.breached, true);
  assert.equal(breach.conditionKey, COST_BREACH_CONDITION_KEY);
  assert.equal(isNeverQuietCondition(breach.conditionKey), true, `${breach.conditionKey} must satisfy isNeverQuietCondition so a worsening LLM-scoring overage can never go silent`);
});

test('checkCostBreach: a run at or under the threshold does not breach', () => {
  const runs = [{ runId: 'gh-run-2', costUsd: 6 }];
  const breach = checkCostBreach(runs, { runId: 'gh-run-2', thresholdUsd: 6 });
  assert.ok(breach);
  assert.equal(breach.breached, false);
});

test('checkCostBreach: sums across THREE invocations under one runId (BRO-3392 — main pass + drain + comparative-rescore.ts)', () => {
  const runsLogPath = tmpRunsLogPath();
  const runId = 'gh-run-3392';
  // Simulates llm-ensemble-score.yml's job: index.ts main pass, index.ts
  // drain, then comparative-rescore.ts — three separate process invocations,
  // same GITHUB_RUN_ID, each calling appendRunSummary() independently the
  // way BRO-3381 wired index.ts and this ticket wires comparative-rescore.ts.
  let runs;
  runs = appendRunSummary({ startedAt: 'x', completedAt: 'x', totalReviews: 5, processed: 5, skipped: 0, errors: 0, tokensUsed: { input: 0, output: 0, total: 0 }, costUsd: 2.5, runId, errorDetails: [] }, { runsLogPath });
  runs = appendRunSummary({ startedAt: 'x', completedAt: 'x', totalReviews: 1, processed: 1, skipped: 0, errors: 0, tokensUsed: { input: 0, output: 0, total: 0 }, costUsd: 1.0, runId, errorDetails: [] }, { runsLogPath });
  runs = appendRunSummary({ startedAt: 'x', completedAt: 'x', totalReviews: 3, processed: 2, skipped: 1, errors: 0, tokensUsed: { input: 0, output: 0, total: 0 }, costUsd: 3.0, runId, errorDetails: [] }, { runsLogPath });

  assert.equal(sumCostUsdForRun(runs, runId), 6.5);
  const breach = checkCostBreach(runs, { runId, thresholdUsd: 5 });
  assert.ok(breach);
  assert.equal(breach.totalUsd, 6.5);
  assert.equal(breach.breached, true);
  assert.equal(breach.conditionKey, COST_BREACH_CONDITION_KEY);
});

test('checkCostBreach: no runId (local/manual run) skips alarming outright', () => {
  const runs = [{ runId: null, costUsd: 1000 }];
  assert.equal(checkCostBreach(runs, { runId: null, thresholdUsd: 6 }), null);
  assert.equal(checkCostBreach(runs, { runId: undefined, thresholdUsd: 6 }), null);
});

test('checkCostBreach: missing/invalid threshold skips alarming outright', () => {
  const runs = [{ runId: 'gh-run-3', costUsd: 1000 }];
  assert.equal(checkCostBreach(runs, { runId: 'gh-run-3', thresholdUsd: null }), null);
  assert.equal(checkCostBreach(runs, { runId: 'gh-run-3', thresholdUsd: NaN }), null);
  assert.equal(checkCostBreach(runs, { runId: 'gh-run-3' }), null);
});
