// BRO-3010: end-to-end tests for scripts/check-sb-breaker.js (the hourly
// ScrapingBee daily breaker). The pure maths is pinned in
// scrapingbee-caps.test.mjs; this file runs the real CLI with the /usage
// fetch stubbed (a --require preload) and every state/ledger path in a temp
// dir, so it proves the wiring: shadow records wouldTripAt and never blocks,
// enforcement is loosen-only (never tighter than 1.5x the 14-day median) and
// never enforces without demand history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'check-sb-breaker.js');

const CAP = 1_000_000;
const BASELINE = 400_000;
const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
// 600k left over 10 days x 1.5 burst = plan ceiling 90,000.
const PLAN_CEILING = 90_000;

function usage(dayCredits) {
  return {
    max_api_credit: CAP,
    used_api_credit: BASELINE + dayCredits,
    renewal_subscription_date: `${dayOffset(10)}T18:40:36.521772`,
  };
}

function historyRows(perDay, days = 14) {
  const rows = [];
  for (let i = 1; i <= days; i++) {
    rows.push({
      day: dayOffset(-i),
      capturedAt: `${dayOffset(-i + 1)}T06:00:00Z`,
      providers: { scrapingbee: { status: 'ok', dayCredits: perDay, cap: CAP, cycleUsed: 100_000 + i } },
    });
  }
  return rows;
}

function run({ dayCredits = 0, env = {}, args = [], history = [], prevState = 'today', usagePayload } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-breaker-'));
  const preload = path.join(dir, 'stub-fetch.cjs');
  fs.writeFileSync(preload, `
    const payload = process.env.FAKE_SB_USAGE;
    global.fetch = async (url) => {
      if (!String(url).includes('app.scrapingbee.com/api/v1/usage')) throw new Error('unexpected fetch ' + url);
      if (payload === 'FAIL') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(payload) };
    };
  `);
  const statePath = path.join(dir, 'sb-circuit-breaker.json');
  if (prevState === 'today') {
    fs.writeFileSync(statePath, JSON.stringify({ day: today(), dayBaseline: BASELINE, lastCycleUsed: BASELINE, updatedAt: new Date().toISOString() }));
  }
  const dailyPath = path.join(dir, 'provider-spend-daily.jsonl');
  fs.writeFileSync(dailyPath, history.map((r) => JSON.stringify(r)).join('\n') + (history.length ? '\n' : ''));
  const transitionsPath = path.join(dir, 'breaker-transitions.jsonl');
  const alertLedger = path.join(dir, 'alert-ledger.json');
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, ['--require', preload, SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SCRAPINGBEE_API_KEY: 'test-sb-key',
        FAKE_SB_USAGE: usagePayload ?? JSON.stringify(usage(dayCredits)),
        SB_BREAKER_STATE_PATH: statePath,
        PROVIDER_SPEND_DAILY_PATH: dailyPath,
        BREAKER_TRANSITIONS_PATH: transitionsPath,
        ALERT_LEDGER_PATH: alertLedger,
        ALERT_DIGEST_QUEUE_PATH: path.join(dir, 'alert-digest-queue.json'),
        ALERT_ATTEMPTS_LOG_PATH: path.join(dir, 'alert-router-attempts.jsonl'),
        SCRAPER_SPEND_LEDGER_PATH: path.join(dir, 'scraper-spend.jsonl'),
        // No shows file → no opening-window shows → no reserve. CI's real
        // data/shows.json can hold opening-week shows (land run 39004637890).
        SB_BREAKER_SHOWS_PATH: path.join(dir, 'no-shows.json'),
        // Isolate the cached core-data/telemetry reads from the runner too.
        GITHUB_WORKFLOW: '',
        BD_OPENING_NIGHT: '',
        ...env,
      },
    });
  } catch (err) {
    status = err.status;
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  const stateRaw = read(statePath);
  const transitions = (read(transitionsPath) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let dryState = null;
  const marker = stdout.indexOf('--dry-run: state not written');
  if (marker >= 0) dryState = JSON.parse(stdout.slice(stdout.indexOf('{', marker)));
  fs.rmSync(dir, { recursive: true, force: true });
  return { stdout, status, state: stateRaw ? JSON.parse(stateRaw) : null, dryState, transitions };
}

test('shadow (default): over the plan ceiling records wouldTripAt, never trippedAt, and consult never blocks', () => {
  const r = run({ dayCredits: 100_000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /SHADOW/);
  assert.match(r.stdout, /would trip \(shadow\)/);
  assert.equal(r.state.shadow, true);
  assert.equal(r.state.enforce, false);
  assert.equal(r.state.ceiling, PLAN_CEILING);
  assert.equal(r.state.ceilingSource, 'plan');
  assert.equal(r.state.dayCredits, 100_000);
  assert.ok(r.state.wouldTripAt, 'wouldTripAt set');
  assert.equal(r.state.trippedAt, null);
  assert.ok(r.transitions.length >= 1, 'a transition row is written');
  assert.ok(r.transitions.every((t) => t.conditionKey === 'sb-circuit-breaker-shadow'), JSON.stringify(r.transitions));

  // The state the checker wrote must not block a real caller.
  const caps = require('./scrapingbee-caps.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-consult-'));
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(p, JSON.stringify(r.state));
  const verdict = caps.consultScrapingbee({ env: { SB_BREAKER_STATE_PATH: p } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(verdict.allowed, true);
});

test('shadow: under the plan ceiling is no would-trip', () => {
  const r = run({ dayCredits: 50_000 });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.state.wouldTripAt, null);
  assert.equal(r.state.trippedAt, null);
  assert.equal(r.state.dayCredits, 50_000);
});

test('enforced (SB_BREAKER_SHADOW=0), loosen-only: a plan ceiling below 1.5x the 14d median is raised to the floor, so normal demand does not trip', () => {
  const r = run({ dayCredits: 120_000, env: { SB_BREAKER_SHADOW: '0' }, history: historyRows(100_000), args: ['--dry-run'] });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.dryState, r.stdout);
  assert.equal(r.dryState.enforce, true);
  assert.equal(r.dryState.median14d, 100_000);
  assert.equal(r.dryState.planCeiling, PLAN_CEILING);
  assert.equal(r.dryState.ceiling, 150_000, 'floored at 1.5 x median, never the tighter plan ceiling');
  assert.match(r.dryState.ceilingSource, /median-floor/);
  assert.match(r.dryState.enforceReason, /loosen-only/);
  assert.equal(r.dryState.trippedAt, null, '120k is above the plan ceiling but below the floor: no trip');
});

test('enforced: over the loosen-only floor trips (trippedAt set)', () => {
  const r = run({ dayCredits: 200_000, env: { SB_BREAKER_SHADOW: '0' }, history: historyRows(100_000), args: ['--dry-run'] });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /TRIPPED/);
  assert.equal(r.dryState.enforce, true);
  assert.ok(r.dryState.trippedAt, 'trippedAt set');
  assert.ok(r.dryState.wouldTripAt, 'the shadow record agrees');
});

test('enforced: a plan ceiling ABOVE the floor is used as-is (the floor only loosens)', () => {
  const r = run({ dayCredits: 80_000, env: { SB_BREAKER_SHADOW: '0' }, history: historyRows(20_000), args: ['--dry-run'] });
  assert.equal(r.dryState.ceiling, PLAN_CEILING);
  assert.equal(r.dryState.ceilingSource, 'plan');
  assert.equal(r.dryState.trippedAt, null);
});

test('enforced without demand history (fewer than 7 clean days) never enforces', () => {
  const r = run({ dayCredits: 500_000, env: { SB_BREAKER_SHADOW: '0' }, history: historyRows(100_000, 6), args: ['--dry-run'] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.dryState.enforce, false);
  assert.match(r.dryState.enforceReason, /no-demand-history/);
  assert.equal(r.dryState.trippedAt, null);
  assert.ok(r.dryState.wouldTripAt, 'still recorded as a would-trip');
});

test('SB_BREAKER_CEILING pins the ceiling; SB_BREAKER_BURST_FACTOR scales the plan share', () => {
  const pinned = run({ dayCredits: 10_000, env: { SB_BREAKER_CEILING: '5000' }, args: ['--dry-run'] });
  assert.equal(pinned.dryState.ceiling, 5000);
  assert.equal(pinned.dryState.ceilingSource, 'env');
  assert.ok(pinned.dryState.wouldTripAt);
  const burst = run({ dayCredits: 10_000, env: { SB_BREAKER_BURST_FACTOR: '2' }, args: ['--dry-run'] });
  assert.equal(burst.dryState.ceiling, 120_000);
});

test('no API key: no-op, state untouched; billing failure: unknown, state untouched', () => {
  const noKey = run({ env: { SCRAPINGBEE_API_KEY: '' }, prevState: 'none' });
  assert.equal(noKey.status, 0);
  assert.match(noKey.stdout, /SCRAPINGBEE_API_KEY not set/);
  assert.equal(noKey.state, null);

  const fail = run({ usagePayload: 'FAIL' });
  assert.equal(fail.status, 0, fail.stdout);
  assert.match(fail.stdout, /billing unknown/);
  assert.equal(fail.state.dayBaseline, BASELINE);
  assert.equal(fail.state.wouldTripAt, undefined, 'prior state file left exactly as it was');
});

test('pack exhausted is not counted as a runaway', () => {
  const r = run({ usagePayload: JSON.stringify({ ...usage(0), used_api_credit: CAP + 12 }), args: ['--dry-run'] });
  assert.equal(r.dryState.packExhausted, true);
  assert.equal(r.dryState.wouldTripAt, null);
});
