import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  checkRepeatSignature, sumCostUsdForUtcDay, reportRollingCostAlerts,
  appendRunSummary, loadCostThresholdUsd, DAILY_COST_CONDITION_KEY,
} = require('./llm-scoring-cost-recording.js');
const { llmScoringBreach } = require('./provider-spend-core.js');
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
});

test('idle runs and malformed signatures do not alert; paid failed attempts can alert', () => {
  for (const entry of [null, {}, run({ processed: -1 }), run({ processed: '158' }),
    run({ processed: 0, tokensUsed: { input: 0 } }), run({ tokensUsed: { input: NaN } })]) {
    assert.deepEqual(checkRepeatSignature([entry, entry, entry], now), []);
  }
  assert.equal(checkRepeatSignature([run({ processed: 0 }), run({ processed: 0 }), run({ processed: 0 })], now)[0].count, 3);
});

test('a UTC day sums across run ids, and is unknown when the log does not cover it', () => {
  const day = '2026-09-30';
  const at = (iso, costUsd, extra = {}) => run({ completedAt: iso, costUsd, ...extra });
  const runs = [at('2026-09-29T23:59:59Z', 100), at('2026-09-30T00:00:00Z', 6), at('2026-09-30T12:00:00Z', 0),
    at('2026-09-30T23:59:59.999Z', 4), at('2026-10-01T00:00:00Z', 100)];
  assert.deepEqual(sumCostUsdForUtcDay(runs, day, { now }), { day, usd: 10, covered: true, runs: 3 });
  // Oldest retained summary is after 00:00Z: earlier runs may have been capped away.
  assert.deepEqual(sumCostUsdForUtcDay(runs.slice(2), day, { now }), { day, usd: null, covered: false, runs: 2 });
  // A run with no usable cost makes the day unknown, never a smaller total.
  for (const costUsd of [undefined, null, '50', NaN, Infinity, -10]) {
    assert.equal(sumCostUsdForUtcDay([...runs, at('2026-09-30T12:00:00Z', costUsd)], day, { now }).covered, false, String(costUsd));
  }
  // Stale log: nothing written after the day ended, so its last runs may be missing.
  assert.equal(sumCostUsdForUtcDay(runs.slice(0, 4), day, { now }).covered, false);
  // Stamps: a stamp at/before 00:00Z vouches for a log whose oldest row is later;
  // with merged writers the latest (narrowest) stamp wins.
  const stamped = (keeps) => [at('2026-09-30T06:00:00Z', 3), at('2026-10-01T01:00:00Z', 1, { logKeepsSince: keeps })];
  assert.equal(sumCostUsdForUtcDay(stamped('2026-09-29T00:00:00.000Z'), day, { now }).usd, 3);
  assert.equal(sumCostUsdForUtcDay(stamped('2026-09-30T06:00:00.000Z'), day, { now }).covered, false);
  const merged = [at('2026-09-30T06:00:00Z', 3, { logKeepsSince: '2026-09-30T05:00:00.000Z' }), ...stamped('2026-09-29T00:00:00.000Z')];
  assert.equal(sumCostUsdForUtcDay(merged, day, { now }).covered, false, 'a wider stamp from another writer does not override a narrower one');
  // The day has not ended yet.
  assert.equal(sumCostUsdForUtcDay(runs, day, { now: new Date('2026-09-30T20:00:00Z') }).covered, false);
  for (const bad of ['2026-9-30', '', null, 'not-a-day']) assert.equal(sumCostUsdForUtcDay(runs, bad, { now }).usd, null);
  assert.equal(sumCostUsdForUtcDay([], day, { now }).covered, false);
  assert.equal(loadCostThresholdUsd(undefined, 'llmScoringDailyUsd'), 10);
});

test('BRO-7576 guard: the scoring writers never raise or resolve the daily spend condition', async () => {
  // $50 inside 24h used to raise it from every scoring run; $0 used to resolve it.
  for (const runs of [[run({ costUsd: 25, runId: 'a' }), run({ costUsd: 25, runId: 'b' })], [run({ costUsd: 0 })]]) {
    const keys = [];
    await reportRollingCostAlerts(runs, {
      now, routeAlert: async a => keys.push(['route', a.conditionKey]),
      resolveCondition: async key => keys.push(['resolve', key]),
    });
    assert.ok(!keys.some(([, k]) => k === 'llm-scoring:daily-cost-breach'), JSON.stringify(keys));
    assert.equal(DAILY_COST_CONDITION_KEY, 'llm-scoring:daily-cost-breach', 'key carried over so the open card is kept');
  }
});

test('repeat alarms route through the owner router even without a run id; dry run sends nothing', async () => {
  const alerts = [];
  const runs = [run({ costUsd: 4 }), run({ costUsd: 4 }), run({ costUsd: 4 })];
  await reportRollingCostAlerts(runs, { now, routeAlert: async a => alerts.push(a), resolveCondition: () => {} });
  assert.deepEqual(alerts.map(a => a.conditionKey), ['llm-scoring:cost-repeat-signature']);
  const { isNeverQuietCondition } = require('./owner-alert-router.js');
  assert.ok(alerts.every(a => isNeverQuietCondition(a.conditionKey)));
  assert.ok(alerts.every(a => a.disposition === 'digest' && a.cooldownHours === 20));
  await reportRollingCostAlerts(runs, { now, dryRun: true, routeAlert: () => assert.fail('dry run routed') });
  await reportRollingCostAlerts([run(), run()], { now, routeAlert: () => assert.fail('healthy run routed'), resolveCondition: () => {} });
  let attempts = 0;
  await reportRollingCostAlerts(runs, { now, resolveCondition: () => {}, routeAlert: async () => {
    attempts++;
    throw new Error('router unavailable');
  } });
  assert.equal(attempts, 1, 'a routing failure must not abort scoring');
});

test('BRO-7576: the 7-day average rule stops the flapping that re-filed the card', () => {
  // Real whole-UTC-day LLM scoring totals, 2026-10-19..11-15, reconstructed
  // from git history of data/llm-scoring-runs.json.
  const usd = [11.30, 4.60, 5.92, 14.44, 14.95, 19.63, 17.97, 19.93, 19.15, 20.32, 8.50, 26.41, 28.95, 24.81,
    20.75, 20.26, 4.90, 3.55, 2.10, 5.20, 4.07, 12.63, 4.57, 5.35, 47.62, 63.60, 3.71, 3.43];
  const start = Date.parse('2026-10-19T00:00:00Z');
  const records = usd.map((cost, i) => ({
    day: new Date(start + i * 86400000).toISOString().slice(0, 10), llmScoring: { status: 'ok', cost },
  }));
  const opens = rule => {
    let open = false; let n = 0;
    records.forEach((rec, i) => { const b = rule(rec, records.slice(0, i)); if (b && !open) n++; open = b; });
    return n;
  };
  const oneDay = rec => rec.llmScoring.cost > 10;
  // null (under 4 measured days) neither opens nor closes.
  const sevenDay = (rec, hist) => { const v = llmScoringBreach(rec, hist, 10); return v ? v.breached : false; };
  assert.equal(opens(oneDay), 5, 'the old one-day rule re-opens with every busy day');
  assert.equal(opens(sevenDay), 2, 'the 7-day average opens only on sustained spend');
  const v = llmScoringBreach(records[27], records.slice(0, 27), 10);
  assert.deepEqual({ ...v }, { avg: 20.13, days: 7, today: 3.43, threshold: 10, breached: true });
});

test('llmScoringBreach: unmeasured days neither alarm nor clear, and do not count as $0', () => {
  const rec = (day, llmScoring) => ({ day, llmScoring });
  const hist = [rec('2026-11-08', { status: 'ok', cost: 20 }), rec('2026-11-09', { status: 'ok', cost: 10 }),
    rec('2026-11-10', { status: 'ok', cost: 30 }), rec('2026-11-11', { status: 'unknown' }),
    rec('2026-11-12', undefined), rec('2026-11-01', { status: 'ok', cost: 999 })];
  // 11-01 is outside the 7-day window; unknown/missing days are skipped, not zeroed.
  assert.deepEqual({ ...llmScoringBreach(rec('2026-11-13', { status: 'ok', cost: 0 }), hist, 10) },
    { avg: 15, days: 4, today: 0, threshold: 10, breached: true });
  // Under 4 measured days is not a trend: no verdict either way.
  assert.equal(llmScoringBreach(rec('2026-11-13', { status: 'ok', cost: 0 }), hist.slice(1), 10), null);
  assert.equal(llmScoringBreach(rec('2026-11-13', { status: 'unknown' }), hist, 10), null);
  assert.equal(llmScoringBreach(rec('2026-11-13', undefined), hist, 10), null);
  for (const line of [null, undefined, NaN, 0, -1, '10']) {
    assert.equal(llmScoringBreach(rec('2026-11-13', { status: 'ok', cost: 50 }), hist, line), null);
  }
  assert.equal(llmScoringBreach(rec('2026-11-13', { status: 'ok', cost: 10 }),
    hist.slice(0, 3).map(r => ({ ...r, llmScoring: { status: 'ok', cost: 10 } })), 10).breached, false, 'at the line is not over it');
});

test('daily spend CLI records yesterday\'s LLM scoring cost only when the run log covers it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-day-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const Module = require('module'), fs = require('fs'), load = Module._load;
    const NativeDate = Date;
    global.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : ['2026-10-01T11:00:00Z'])); }
      static now() { return new NativeDate('2026-10-01T11:00:00Z').getTime(); }
    };
    Module._load = function(id, parent, ...rest) {
      if (id === './lib/provider-billing') return {
        fetchBdZoneCostDay: async () => null, fetchBbUsageForDay: async () => null,
        fetchSbUsage: async () => null, fetchSdAccount: async () => null,
      };
      if (id === 'fs') return { ...fs, readFileSync(p, ...args) {
        if (String(p).endsWith('/data/llm-scoring-runs.json')) return process.env.TEST_RUNS;
        if (String(p).endsWith('/provider-spend-daily.jsonl') && process.env.TEST_LEDGER) return process.env.TEST_LEDGER;
        if (String(p).includes('/data/')) throw new Error('No test ledger');
        return fs.readFileSync(p, ...args);
      }};
      return load.call(this, id, parent, ...rest);
    };
  `);
  const cli = (runs, ledger = []) => spawnSync(process.execPath, ['-r', preload, 'scripts/check-provider-spend.js', '--dry-run'], {
    cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEST_RUNS: JSON.stringify(runs), TEST_LEDGER: ledger.map(r => JSON.stringify(r)).join('\n') },
  });
  const day = (d, llmScoring) => ({ day: d, providers: {}, ...(llmScoring ? { llmScoring } : {}) });
  const covered = cli([run({ completedAt: '2026-09-29T22:00:00Z', costUsd: 1 }),
    run({ completedAt: '2026-09-30T08:00:00Z', costUsd: 7.5, processed: 1 }),
    run({ completedAt: '2026-09-30T20:00:00Z', costUsd: 5, processed: 2 }),
    run({ completedAt: '2026-10-01T10:00:00Z', costUsd: 40, processed: 3 })]);
  assert.equal(covered.status, 0, covered.stdout + covered.stderr);
  // One measured day is not a trend: recorded, but no verdict.
  assert.match(covered.stdout, /2026-09-30: LLM scoring \$12\.5 \(2 run summaries\)\n/);
  // With measured history the 7-day average is judged; 09-29 was 'unknown' in
  // the ledger and is re-measured from the log ($1 + $3 = $4): (12.5+4+20+20)/4.
  const runsWithDayBefore = [run({ completedAt: '2026-09-28T23:00:00Z', costUsd: 9 }),
    run({ completedAt: '2026-09-29T01:00:00Z', costUsd: 3 }), ...JSON.parse(JSON.stringify([
      run({ completedAt: '2026-09-29T22:00:00Z', costUsd: 1 }),
      run({ completedAt: '2026-09-30T08:00:00Z', costUsd: 7.5, processed: 1 }),
      run({ completedAt: '2026-09-30T20:00:00Z', costUsd: 5, processed: 2 }),
      run({ completedAt: '2026-10-01T10:00:00Z', costUsd: 40, processed: 3 })]))];
  const withHistory = cli(runsWithDayBefore, [day('2026-09-27', { status: 'ok', cost: 20 }),
    day('2026-09-28', { status: 'ok', cost: 20 }), day('2026-09-29', { status: 'unknown' })]);
  assert.equal(withHistory.status, 0, withHistory.stdout + withHistory.stderr);
  assert.match(withHistory.stdout, /2026-09-30: LLM scoring \$12\.5 \(2 run summaries\); 4-day average \$14\.13 vs \$10 line: OVER/);
  const uncovered = cli([run({ completedAt: '2026-09-30T08:00:00Z', costUsd: 50 })]);
  assert.equal(uncovered.status, 0, uncovered.stdout + uncovered.stderr);
  assert.match(uncovered.stdout, /2026-09-30: LLM scoring could not measure/);
  assert.doesNotMatch(uncovered.stdout, /line: OVER/);
  // A re-run that can no longer see the whole day keeps the earlier figure.
  const rerun = cli([run({ completedAt: '2026-09-30T08:00:00Z', costUsd: 50 })], [day('2026-09-30', { status: 'ok', cost: 12.5, runs: 2 })]);
  assert.match(rerun.stdout, /2026-09-30: LLM scoring \$12\.5 \(2 run summaries\)/);
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

test('retention keeps every summary since 00:00Z yesterday even when there are over 100', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-repeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runsLogPath = path.join(dir, 'runs.json');
  const runs = Array.from({ length: 120 }, (_, i) => run({ processed: i + 1 }));
  // BRO-7576: 05:00Z yesterday is older than 24h but still needed for
  // yesterday's whole-day total; 23:59Z the day before is not.
  runs.unshift(run({ completedAt: '2026-09-30T05:00:00Z', processed: 0 }));
  runs.unshift(run({ completedAt: '2026-09-29T23:59:59Z', processed: -1 }));
  fs.writeFileSync(runsLogPath, JSON.stringify(runs));
  const saved = appendRunSummary(run({ completedAt: now.toISOString() }), { runsLogPath });
  assert.equal(saved.length, 122);
  assert.equal(saved[0].processed, 0);
  assert.equal(sumCostUsdForUtcDay(saved, '2026-09-30', { now: new Date('2026-10-01T23:00:00Z') }).covered, true);
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
      if (id.includes('owner-alert-router')) return { routeAlert: async () => {}, resolveCondition: () => {} };
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
