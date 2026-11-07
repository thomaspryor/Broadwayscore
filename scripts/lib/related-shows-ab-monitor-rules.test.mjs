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

// BRO-6868: the real 2026-11-02 readout (~5% of people without a first-session
// pageview join) used to suppress the result and email [CRITICAL] every week.
const live = (nC, mC, nV, mV) => summarizeRelatedShows([
  ['control', nC, Math.floor(nC * .1), Math.floor(nC * .4), mC, 0],
  ['compact-after-reviews', nV, Math.floor(nV * .12), Math.floor(nV * .4), mV, 0],
], { ok: true, problem: null });

test('a small join gap (live 2026-11-02 shape) is tolerated and yields a p-value', () => {
  const s = live(893, 48, 950, 38);
  assert.equal(s.primary.suppressed, null);
  assert.ok(Number.isFinite(s.primary.p));
  assert.deepEqual(kinds(decideRelatedShowsAlerts(s, {}, NOW)), []);
});

test('a large or lopsided join gap still suppresses the result', () => {
  assert.match(live(1000, 150, 1000, 140).primary.suppressed, /pageview join/); // >10% each
  assert.match(live(1000, 10, 1000, 80).primary.suppressed, /pageview join/);   // 7pp apart
  assert.equal(live(1000, 100, 1000, 100).primary.suppressed, null);            // exactly 10% ok
});

test('below the planned sample a data problem is log-only, never an email', () => {
  const s = live(893, 150, 950, 150);
  const [a] = decideRelatedShowsAlerts(s, {}, NOW).alerts;
  assert.equal(a.kind, 'data-problem');
  assert.equal(a.logOnly, true);
  assert.equal(a.email, false);
  assert.equal(a.severity, 'warning');
  // log-only alerts never consume the email cooldown
  assert.equal(decideRelatedShowsAlerts(s, {}, NOW).state.lastDataProblemAlertAt, undefined);
});

test('at the planned sample a data problem emails in plain English, not [CRITICAL] jargon', () => {
  const s = summary();
  s.primary.suppressed = 'exposed people without a usable first-session pageview join';
  const [a] = decideRelatedShowsAlerts(s, {}, NOW).alerts;
  assert.equal(a.email, true);
  assert.equal(a.subjectLabel, 'ACTION NEEDED');
  assert.match(a.description, /A\/B test on show pages/);
  assert.match(a.description, /no readout yet/);
  assert.doesNotMatch(a.description, /maintainer|finite probability|statistic/i);
  // a suppressed result is explained once, not twice
  assert.equal((a.description.match(/pageview join/g) || []).length, 1);
});

test('a problem quoted inside a longer one is only shown once in the email', () => {
  const s = summarizeRelatedShows([['control', 3200, 600, 2200, 0, 0], ['compact-after-reviews', 3210, 650, 2100, 0, 0]],
    { ok: false, problem: 'flag inactive' });
  const [a] = decideRelatedShowsAlerts(s, {}, NOW).alerts;
  assert.equal((a.description.match(/flag health failed/g) || []).length, 1);
});

// Review follow-ups (BRO-6868): tighter gap, early email for real breakage, stall check.
test('join-gap boundaries: 10% per arm and 2pp between arms', () => {
  assert.equal(live(1000, 100, 1000, 100).primary.suppressed, null);
  assert.match(live(1000, 101, 1000, 101).primary.suppressed, /pageview join/);
  assert.equal(live(1000, 50, 1000, 70).primary.suppressed, null);            // 2.0pp apart
  assert.match(live(1000, 40, 1000, 70).primary.suppressed, /pageview join/); // 3pp apart
  assert.equal(live(3140, 170, 3140, 126).primary.suppressed, null);          // full sample, 1.4pp
});

test('contamination, a missing arm and an unhealthy flag email immediately, even below the sample', () => {
  const crossed = summarizeRelatedShows([
    ['control', 900, 90, 400, 0, 5], ['compact-after-reviews', 950, 110, 420, 0, 0]], { ok: true, problem: null });
  const noArm = summarizeRelatedShows([['control', 900, 90, 400, 0, 0]], { ok: true, problem: null });
  const sick = summarizeRelatedShows([
    ['control', 900, 90, 400, 0, 0], ['compact-after-reviews', 950, 110, 420, 0, 0]], { ok: false, problem: 'flag inactive' });
  for (const s of [crossed, noArm, sick]) {
    const [a] = decideRelatedShowsAlerts(s, {}, NOW).alerts;
    assert.equal(a.email, true);
    assert.equal(a.title, 'Related shows test: the data has a problem');
    assert.match(a.description, /still collecting people/);
  }
  assert.ok(noArm.primary.degenerate);
  assert.doesNotMatch(String(noArm.primary.suppressed), /pageview join/);
});

test('stalled exposure is flagged after five days, not before, and never at the planned sample', () => {
  const s = live(900, 20, 950, 20);
  const first = decideRelatedShowsAlerts(s, {}, NOW);
  assert.deepEqual(kinds(first), []);
  assert.equal(first.state.lastMinN, 900);
  const day = 24 * 60 * 60 * 1000;
  assert.deepEqual(kinds(decideRelatedShowsAlerts(s, first.state, NOW + 2 * day)), []);
  const grown = decideRelatedShowsAlerts(live(1100, 20, 1150, 20), first.state, NOW + 7 * day);
  assert.deepEqual(kinds(grown), []);
  const stalled = decideRelatedShowsAlerts(s, first.state, NOW + 7 * day);
  assert.deepEqual(kinds(stalled), ['data-problem']);
  assert.match(stalled.alerts[0].description, /exposure may have stopped/);
  assert.deepEqual(kinds(decideRelatedShowsAlerts(summary(), { lastMinN: 3140, lastMinNAt: NOW - 9 * day }, NOW)), ['ready-to-judge']);
});
