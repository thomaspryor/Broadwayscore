import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  checkRepeatSignature, checkDailyCostBreach, reportRollingCostAlerts,
  appendRunSummary, loadCostThresholdUsd,
} = require('./llm-scoring-cost-recording.js');
const now = new Date('2026-10-01T11:00:00Z');
const run = (overrides = {}) => ({
  completedAt: '2026-10-01T10:00:00Z', processed: 158,
  tokensUsed: { input: 415935 }, costUsd: 1.16, ...overrides,
});

test('three or more identical signatures alert across GitHub runs; two do not', () => {
  assert.deepEqual(checkRepeatSignature([run(), run()], now), []);
  for (const count of [3, 4, 27]) {
    const matches = checkRepeatSignature(Array.from({ length: count }, (_, i) => run({ runId: String(i) })), now);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].count, count);
    assert.equal(matches[0].processed, 158);
    assert.equal(matches[0].input, 415935);
  }
});

test('signatures require both fields to match, and all repeated groups are reported', () => {
  const runs = [run(), run(), run({ processed: 157 }), run({ tokensUsed: { input: 415647 } })];
  assert.deepEqual(checkRepeatSignature(runs, now), []);
  runs.push(run(), run({ processed: 157 }), run({ processed: 157 }));
  assert.deepEqual(checkRepeatSignature(runs, now).map(r => [r.processed, r.count]), [[158, 3], [157, 3]]);
});

test('rolling window includes the 24h boundary but excludes older, future and invalid timestamps', () => {
  const edge = run({ completedAt: '2026-09-30T11:00:00Z' });
  const outside = [run({ completedAt: '2026-09-30T10:59:59.999Z' }),
    run({ completedAt: '2026-10-01T11:00:00.001Z' }), run({ completedAt: 'invalid' })];
  assert.deepEqual(checkRepeatSignature([run(), run(), ...outside], now), []);
  assert.equal(checkRepeatSignature([run(), run(), edge, ...outside], now)[0].count, 3);
  assert.equal(checkDailyCostBreach([run(), edge, ...outside], { now, thresholdUsd: 10 }).totalUsd, 2.32);
});

test('idle runs and malformed signatures do not alert; paid failed attempts can alert', () => {
  for (const entry of [null, {}, run({ processed: -1 }), run({ processed: '158' }),
    run({ processed: 0, tokensUsed: { input: 0 } }), run({ tokensUsed: { input: NaN } })]) {
    assert.deepEqual(checkRepeatSignature([entry, entry, entry], now), []);
  }
  assert.equal(checkRepeatSignature([run({ processed: 0 }), run({ processed: 0 }), run({ processed: 0 })], now)[0].count, 3);
});

test('daily spend sums across run ids, ignores invalid costs, and only breaches above the line', () => {
  const runs = [run({ costUsd: 6, runId: 'one' }), run({ costUsd: 4, runId: 'two' }),
    ...[undefined, '50', NaN, Infinity, -10].map(costUsd => run({ costUsd }))];
  assert.equal(checkDailyCostBreach(runs, { now, thresholdUsd: 10 }).breached, false);
  runs.push(run({ costUsd: 0.01 }));
  assert.equal(checkDailyCostBreach(runs, { now, thresholdUsd: 10 }).breached, true);
  assert.equal(checkDailyCostBreach(runs, { now, thresholdUsd: NaN }), null);
  assert.equal(loadCostThresholdUsd(undefined, 'llmScoringDailyUsd'), 10);
});

test('rolling alarms route through the owner router even without a run id; dry run sends nothing', async () => {
  const alerts = [];
  const runs = [run({ costUsd: 4 }), run({ costUsd: 4 }), run({ costUsd: 4 })];
  await reportRollingCostAlerts(runs, { now, thresholdUsd: 10, routeAlert: async a => alerts.push(a) });
  assert.deepEqual(alerts.map(a => a.conditionKey), ['llm-scoring:daily-cost-breach', 'llm-scoring:cost-repeat-signature']);
  const { isNeverQuietCondition } = require('./owner-alert-router.js');
  assert.ok(alerts.every(a => isNeverQuietCondition(a.conditionKey)));
  assert.ok(alerts.every(a => a.disposition === 'digest' && a.cooldownHours === 20));
  await reportRollingCostAlerts(runs, { now, thresholdUsd: 10, dryRun: true, routeAlert: () => assert.fail('dry run routed') });
  await reportRollingCostAlerts([run(), run()], { now, thresholdUsd: 10, routeAlert: () => assert.fail('healthy run routed') });
  let attempts = 0;
  await reportRollingCostAlerts(runs, { now, thresholdUsd: 10, routeAlert: async () => {
    attempts++;
    throw new Error('router unavailable');
  } });
  assert.equal(attempts, 2, 'a routing failure must not abort scoring or suppress the other alarm');
  const independent = [];
  await reportRollingCostAlerts(runs, { now, thresholdUsd: null, routeAlert: async a => independent.push(a) });
  assert.equal(independent.length, 1, 'repeat detection must work even when the daily threshold is unavailable');
});

test('daily spend CLI checks repeat signatures: three alert, two stay quiet, without billing requests', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-daily-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'preload.cjs');
  for (const count of [2, 3]) {
    const script = `
      const Module = require('module'), fs = require('fs'), load = Module._load;
      const NativeDate = Date;
      global.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ['2026-10-01T11:00:00Z'])); }
      };
      Module._load = function(id, parent, ...rest) {
        if (id === './lib/provider-billing') return {
          fetchBdZoneCostDay: async () => null, fetchBbUsageForDay: async () => null,
          fetchSbUsage: async () => null, fetchSdAccount: async () => null,
        };
        if (id === 'fs') return { ...fs, readFileSync(p, ...args) {
          if (String(p).endsWith('/data/llm-scoring-runs.json')) return process.env.TEST_RUNS;
          if (String(p).includes('/data/')) throw new Error('No test ledger');
          return fs.readFileSync(p, ...args);
        }};
        return load.call(this, id, parent, ...rest);
      };
    `;
    fs.writeFileSync(preload, script);
    const result = spawnSync(process.execPath, ['-r', preload, 'scripts/check-provider-spend.js', '--dry-run'], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TEST_RUNS: JSON.stringify(Array.from({ length: count }, () => run())) },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal((result.stdout + result.stderr).includes('llm-scoring:cost-repeat-signature'), count === 3);
  }
});

test('retention preserves all summaries in the last 24h even when there are over 100', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-repeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runsLogPath = path.join(dir, 'runs.json');
  const runs = Array.from({ length: 120 }, (_, i) => run({ processed: i + 1 }));
  runs.unshift(run({ completedAt: '2026-09-29T10:00:00Z' }));
  fs.writeFileSync(runsLogPath, JSON.stringify(runs));
  const saved = appendRunSummary(run({ completedAt: now.toISOString() }), { runsLogPath });
  assert.equal(saved.length, 121);
  assert.equal(saved[0].processed, 1);
});

test('full scoring runs persist Claude cache usage in ensemble and single-model summaries', t => {
  const repo = path.resolve(import.meta.dirname, '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-summary-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Exercise the real index.ts through scoring and persistence. Redirect ALL
  // data paths so neither the private review clone nor in-flight batch state
  // can be read or changed. Only model calls and alert delivery are stubbed.
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const Module = require('module'), fs = require('fs'), path = require('path');
    const load = Module._load;
    const data = path.join(process.cwd(), 'data');
    const scratch = process.env.SCORING_TEST_DATA;
    const redirect = p => typeof p === 'string' && (p === data || p.startsWith(data + path.sep))
      ? scratch + p.slice(data.length) : p;
    const isolatedFs = new Proxy(fs, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (args.length) args[0] = redirect(args[0]);
        return value(...args);
      };
    }});
    let scored = false;
    class StubScorer {
      getModelCount() { return 2; }
      async scoreReviewFile(review) {
        scored = true;
        return { success: true, scoredFile: { ...review,
          llmScore: { score: 80, bucket: 'positive', confidence: 'high', reasoning: 'A persuasive performance with assured direction.' }
        }};
      }
      getTokenUsage() {
        const claude = { input: scored ? 1000 : 0, output: scored ? 100 : 0,
          cacheRead: scored ? 400 : 0, cacheWrite: scored ? 200 : 0 };
        if (!process.argv.includes('--ensemble')) return { ...claude, total: scored ? 1700 : 0 };
        return { claude, openai: { input: scored ? 500 : 0, output: scored ? 50 : 0 },
          gemini: null, kimi: null, total: scored ? 2250 : 0 };
      }
    }
    Module._load = function(id, parent, ...rest) {
      if (id === 'fs' || id === 'node:fs') return isolatedFs;
      if (id === './scorer') return { ReviewScorer: StubScorer };
      if (id === './ensemble-scorer') return { EnsembleReviewScorer: StubScorer };
      if (id.includes('owner-alert-router')) return { routeAlert: async () => {} };
      if (id === 'child_process') return { ...load.call(this, id, parent, ...rest),
        execSync() { throw new Error('Git and shell execution forbidden in scoring test'); } };
      return load.call(this, id, parent, ...rest);
    };
    global.fetch = () => { throw new Error('Network forbidden in scoring test'); };
  `);
  for (const ensemble of [true, false]) {
    const scratch = path.join(dir, ensemble ? 'ensemble' : 'single');
    const reviewDir = path.join(scratch, 'review-texts/cache-test-2026');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'shows.json'), JSON.stringify({ shows: [
      { id: 'cache-test-2026', title: 'Cache Test', status: 'closed', openingDate: '2026-01-01', category: 'broadway' },
    ] }));
    fs.writeFileSync(path.join(reviewDir, 'variety.json'), JSON.stringify({
      showId: 'cache-test-2026', outletId: 'variety', criticName: 'Test Critic',
      fullText: 'Cache Test is a richly entertaining play whose compelling performances give each scene emotional weight. The director guides a thoughtful ensemble through the story with precision and warmth. Its inventive staging brings the characters into sharp focus, while a beautifully restrained central performance anchors the evening. The second act deepens the relationships with moments of unexpected humor and tenderness. Although the final scene feels slightly rushed, the production earns its moving conclusion through careful attention to detail.',
    }));
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', preload,
      'scripts/llm-scoring/index.ts', '--show=cache-test-2026', '--rescore', '--limit=1', '--checkpoint=0',
      ...(ensemble ? ['--ensemble'] : [])], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, SCORING_TEST_DATA: scratch, ANTHROPIC_API_KEY: 'test-stub', OPENAI_API_KEY: 'test-stub',
        GITHUB_RUN_ID: '', GITHUB_ACTIONS: '', BSC_STAGE_LATENCY_MUTE: '1', TS_NODE_PROJECT: 'scripts/tsconfig.json' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summaries = JSON.parse(fs.readFileSync(path.join(scratch, 'llm-scoring-runs.json'), 'utf8'));
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].processed, 1, result.stdout);
    assert.equal(summaries[0].tokensUsed.cacheRead, 400);
    assert.equal(summaries[0].tokensUsed.cacheWrite, 200);
    assert.ok(summaries[0].costUsd > 0);
  }
});

test('BRO-3464: per-invocation breakdown is recoverable and legacy entries land in unknown', async () => {
  const { sumCostUsdBySource, sumCostUsdForRun, reportRunCostBreach } = (await import('node:module')).createRequire(import.meta.url)('./llm-scoring-cost-recording.js');
  const runs = [
    { runId: '9', source: 'index', costUsd: 4 },
    { runId: '9', source: 'index', costUsd: 3 },
    { runId: '9', source: 'comparative-rescore', costUsd: 5 },
    { runId: '9', costUsd: 1 },
    { runId: '8', source: 'index', costUsd: 50 },
  ];
  const by = sumCostUsdBySource(runs, '9');
  assert.deepEqual(by, { index: 7, 'comparative-rescore': 5, unknown: 1 });
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), sumCostUsdForRun(runs, '9'));
  const alerts = [];
  const breach = await reportRunCostBreach(runs, { runId: '9', thresholdUsd: 10, routeAlert: async (a) => { alerts.push(a); } });
  assert.equal(breach.breached, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].description, /index \$7\.00, comparative-rescore \$5\.00, unknown \$1\.00/);
  assert.equal(alerts[0].conditionKey, 'llm-scoring:cost-breach');
  assert.equal(alerts[0].disposition, 'digest');
});

test('BRO-3464: reportRunCostBreach is non-fatal and skips local runs and under-threshold runs', async () => {
  const { reportRunCostBreach } = (await import('node:module')).createRequire(import.meta.url)('./llm-scoring-cost-recording.js');
  const runs = [{ runId: '9', source: 'index', costUsd: 20 }];
  assert.equal(await reportRunCostBreach(runs, { runId: null, thresholdUsd: 1, routeAlert: async () => { throw new Error('no'); } }), null);
  assert.equal((await reportRunCostBreach(runs, { runId: '9', thresholdUsd: 100, routeAlert: async () => { throw new Error('no'); } })).breached, false);
  assert.equal(await reportRunCostBreach(runs, { runId: '9', thresholdUsd: 1, routeAlert: async () => { throw new Error('boom'); } }), null);
});
