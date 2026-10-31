import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { summarizeRelatedShows } = require('./related-shows-ab-analysis');
const { decideRelatedShowsAlerts, COOLDOWN_MS } = require('./related-shows-ab-monitor-rules');
const NOW = 1_800_000_000_000;
const summary = (n = 3140, m = n) => summarizeRelatedShows([
  ['control', n, Math.floor(n * .19), Math.floor(n * .7), 0, 0],
  ['compact-after-reviews', m, Math.floor(m * .21), Math.floor(m * .7), 0, 0],
], { ok: true, problem: null });
const kinds = r => r.alerts.map(a => a.kind);

test('906 floor and 3139 are never stopping rules; both arms must reach 3140', () => {
  for (const [n, m] of [[906, 906], [3139, 3139], [4000, 3139]]) {
    assert.deepEqual(kinds(decideRelatedShowsAlerts(summary(n, m), {}, NOW)), []);
  }
});

test('ready-to-judge fires once at the fixed stop, independent of p-value', () => {
  for (const p of [0, .01, .99, 1]) {
    const s = summary();
    s.primary.p = p;
    const result = decideRelatedShowsAlerts(s, {}, NOW);
    assert.deepEqual(kinds(result), ['ready-to-judge']);
    assert.equal(result.alerts[0].email, true);
    assert.equal(result.alerts[0].stampKey, 'readyToJudgeAlertAt');
    assert.deepEqual(kinds(decideRelatedShowsAlerts(s, result.state, NOW + COOLDOWN_MS * 5)), []);
  }
});

test('suppressed and degenerate results alert instead of consuming readiness', () => {
  for (const reason of ['suppressed', 'degenerate']) {
    const s = summary();
    s.primary[reason] = 'broken input';
    const result = decideRelatedShowsAlerts(s, {}, NOW);
    assert.deepEqual(kinds(result), ['data-problem']);
    assert.equal(result.state.readyToJudgeAlertAt, undefined);
    assert.match(result.alerts[0].description, /broken input/);
    assert.deepEqual(kinds(decideRelatedShowsAlerts(summary(), result.state, NOW + 1)), ['ready-to-judge']);
  }
});

test('data problems cool down for six days and can still alert after readiness', () => {
  const s = summary();
  s.primary.p = null;
  const result = decideRelatedShowsAlerts(s, { readyToJudgeAlertAt: NOW - 1 }, NOW);
  assert.deepEqual(kinds(result), ['data-problem']);
  assert.deepEqual(kinds(decideRelatedShowsAlerts(s, result.state, NOW + 1)), []);
  assert.deepEqual(kinds(decideRelatedShowsAlerts(s, result.state, NOW + COOLDOWN_MS)), ['data-problem']);
});

test('malformed summaries and nonfinite primary values fail closed', () => {
  for (const s of [null, {}, { ...summary(), variants: [] },
    { ...summary(), variants: [summary().variants[0], summary().variants[0]] },
    { ...summary(), flagHealth: null }, { ...summary(), flagHealth: { ok: false } },
    { ...summary(), stoppingNPerArm: 906 }, { ...summary(), startDate: '2026-10-01' },
    { ...summary(), flag: 'other' }]) {
    assert.deepEqual(kinds(decideRelatedShowsAlerts(s, {}, NOW)), ['data-problem']);
  }
  for (const p of [null, undefined, NaN, Infinity, -.1, 1.1, '0.01']) {
    const s = summary();
    s.primary.p = p;
    assert.deepEqual(kinds(decideRelatedShowsAlerts(s, {}, NOW)), ['data-problem']);
  }
  const s = summary();
  s.primary.z = NaN;
  assert.deepEqual(kinds(decideRelatedShowsAlerts(s, {}, NOW)), ['data-problem']);
});

test('invalid per-arm counts cannot trigger readiness', () => {
  for (const patch of [{ n: '3140' }, { n: Infinity }, { n: 3140.1 }, { conv: -1 }, { conv: 4000 }]) {
    const s = summary();
    Object.assign(s.variants[0], patch);
    assert.deepEqual(kinds(decideRelatedShowsAlerts(s, {}, NOW)), ['data-problem']);
  }
});

test('rules preserve input state and make no winner claim', () => {
  const state = Object.freeze({ unrelated: true });
  const s = summary();
  const before = JSON.stringify(s);
  const result = decideRelatedShowsAlerts(s, state, NOW);
  assert.equal(result.state.unrelated, true);
  assert.equal(state.readyToJudgeAlertAt, undefined);
  assert.equal(JSON.stringify(s), before);
  assert.doesNotMatch(JSON.stringify(result.alerts), /winner|significant|rollout|stop the flag/i);
});

test('real weekly runner: dry-run writes nothing; failed delivery retries; success persists once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-shows-monitor-'));
  const statePath = path.join(dir, 'state.json');
  const notify = require('./discord-notify');
  const original = notify.sendAlert;
  let deliveries = 0;
  let delivered = false;
  notify.sendAlert = async () => { deliveries++; return delivered; };
  // Require the real runner after replacing its transport. No external send.
  const runnerPath = require.resolve('./weekly-monitor-runner');
  delete require.cache[runnerPath];
  const { runWeeklyMonitor } = require('./weekly-monitor-runner');
  const options = {
    loadData: async () => summary(), decideFn: decideRelatedShowsAlerts,
    statePath, logData: () => {},
  };
  try {
    await runWeeklyMonitor({ ...options, dryRun: true });
    assert.equal(deliveries, 0);
    assert.equal(fs.existsSync(statePath), false);
    await runWeeklyMonitor(options);
    assert.equal(deliveries, 1);
    assert.equal(JSON.parse(fs.readFileSync(statePath)).readyToJudgeAlertAt, undefined);
    delivered = true;
    await runWeeklyMonitor(options);
    assert.equal(deliveries, 2);
    assert.ok(JSON.parse(fs.readFileSync(statePath)).readyToJudgeAlertAt);
    await runWeeklyMonitor(options);
    assert.equal(deliveries, 2);
    // Corrupted analysis after readiness still alerts and retries on failure.
    delivered = false;
    const broken = summary();
    broken.primary.suppressed = 'join unavailable';
    await runWeeklyMonitor({ ...options, loadData: () => broken });
    assert.equal(JSON.parse(fs.readFileSync(statePath)).lastDataProblemAlertAt, undefined);
    await assert.rejects(runWeeklyMonitor({ ...options, loadData: () => { throw new Error('query failed'); } }), /query failed/);
  } finally {
    notify.sendAlert = original;
    delete require.cache[runnerPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
