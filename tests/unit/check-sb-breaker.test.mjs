// BRO-3010: drives the real scripts/check-sb-breaker.js end to end with the
// billing fetch and the alert router stubbed (a -r preload swaps them in the
// require cache), every state/ledger path redirected into a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realNowMs } from '../helpers/clock-shift.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-sb-breaker.js');
// Child process runs on the REAL clock; stamp from it (BRO-5206).
const today = new Date(realNowMs()).toISOString().slice(0, 10);

function daysBefore(n) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

function run({ usage, prevState = null, env = {}, history = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbbreaker-'));
  const statePath = path.join(dir, 'sb.json');
  const transitions = path.join(dir, 'transitions.jsonl');
  const daily = path.join(dir, 'daily.jsonl');
  const alerts = path.join(dir, 'alerts.json');
  const resolves = path.join(dir, 'resolves.txt');
  if (prevState) fs.writeFileSync(statePath, JSON.stringify(prevState));
  fs.writeFileSync(daily, history.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const path = require('path');
    const billing = require(${JSON.stringify(path.join(ROOT, 'scripts/lib/provider-billing.js'))});
    billing.fetchSbUsage = async () => (${JSON.stringify(usage)});
    const routerPath = require.resolve(${JSON.stringify(path.join(ROOT, 'scripts/lib/owner-alert-router.js'))});
    require.cache[routerPath] = { id: routerPath, filename: routerPath, loaded: true, exports: {
      routeAlert: async (a) => { require('fs').appendFileSync(${JSON.stringify(alerts)}, JSON.stringify(a) + '\\n'); },
      // Every condition reads as open, so a resolve call is observable.
      resolveCondition: (k) => { require('fs').appendFileSync(${JSON.stringify(resolves)}, k + '\\n'); return true; },
    } };
  `);
  const res = spawnSync(process.execPath, ['-r', preload, SCRIPT], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      SCRAPINGBEE_API_KEY: 'test-key',
      SB_BREAKER_STATE_PATH: statePath,
      BREAKER_TRANSITIONS_PATH: transitions,
      PROVIDER_SPEND_DAILY_PATH: daily,
      SB_BREAKER_SHADOW: '', SB_BREAKER_CEILING: '', SB_BREAKER_BURST_FACTOR: '',
      ...env,
    },
  });
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  return {
    code: res.status, out: `${res.stdout}${res.stderr}`,
    state: fs.existsSync(statePath) ? JSON.parse(read(statePath)) : null,
    rows: read(transitions).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    alerts: read(alerts).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    resolves: read(resolves).split('\n').filter(Boolean),
  };
}

const usage = (cycleUsed, cap = 1000000) => ({ cycleUsed, cap, renewalDate: daysBefore(-20) });
const prev = (lastCycleUsed, extra = {}) => ({ day: today, dayBaseline: 100000, lastCycleUsed, updatedAt: new Date(realNowMs()).toISOString(), ...extra });
const history = Array.from({ length: 10 }, (_, k) => ({
  day: daysBefore(k + 1), capturedAt: `${daysBefore(k + 1)}T23:00:00Z`,
  providers: { scrapingbee: { status: 'ok', cycleUsed: 100000, cap: 1000000, dayCredits: 30000 } },
}));

test('SHADOW (default): a would-trip writes wouldTripAt + a shadow transition row, never trippedAt, never alerts', () => {
  // 100k baseline, 300k now → 200k today vs ceiling (900k/20*1.5=67.5k)
  const r = run({ usage: usage(300000), prevState: prev(250000), history });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.shadow, true);
  assert.equal(r.state.trippedAt, null);
  assert.ok(r.state.wouldTripAt, r.out);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].conditionKey, 'sb-circuit-breaker-shadow');
  assert.equal(r.rows[0].to, 'tripped');
  assert.equal(r.alerts.length, 0);
});

test('SHADOW: an exhausted pack is not a would-trip', () => {
  const r = run({ usage: usage(1000005), prevState: prev(900000, { dayBaseline: 900000 }), history });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.packExhausted, true);
  assert.equal(r.state.wouldTripAt, null);
  assert.equal(r.rows.length, 0);
});

test('ENFORCED (SB_BREAKER_SHADOW=0) with demand history: trips, sets trippedAt, records the real key, alerts once', () => {
  const r = run({ usage: usage(300000), prevState: prev(250000), history, env: { SB_BREAKER_SHADOW: '0' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.enforce, true);
  assert.ok(r.state.trippedAt);
  assert.equal(r.rows[0].conditionKey, 'sb-circuit-breaker');
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].title, /ScrapingBee daily breaker TRIPPED/);
});

test('ENFORCED without 7 days of demand history does not enforce (stays a would-trip only)', () => {
  const r = run({ usage: usage(300000), prevState: prev(250000), history: history.slice(0, 3), env: { SB_BREAKER_SHADOW: '0' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.enforce, false);
  assert.equal(r.state.trippedAt, null);
  assert.match(r.state.enforceReason, /no-demand-history/);
});

test('ENFORCED loosen-only: a pinned ceiling below the 14d median is lifted to the median', () => {
  // today 20k < 1.5x median 45k; pin 10k would trip, the floor must not
  const r = run({ usage: usage(120000), prevState: prev(100000), history, env: { SB_BREAKER_SHADOW: '0', SB_BREAKER_CEILING: '10000' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.ceiling, 45000);
  assert.match(r.state.ceilingSource, /median-floor/);
  assert.equal(r.state.trippedAt, null);
});

test('ENFORCED: a trip recorded today stays tripped when the pack then runs out (BRO-3010 review)', () => {
  const tripped = prev(900000, { dayBaseline: 100000, trippedAt: new Date(realNowMs()).toISOString() });
  const r = run({ usage: usage(1000005), prevState: tripped, history, env: { SB_BREAKER_SHADOW: '0' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.packExhausted, true);
  assert.ok(r.state.trippedAt, 'exhaustion must not clear an existing trip');
  assert.equal(r.alerts.length, 0, 'no state change, no alert');
});

test('switching back to SHADOW resolves an open enforced incident (BRO-3010 review)', () => {
  const tripped = prev(250000, { trippedAt: new Date(realNowMs()).toISOString() });
  const r = run({ usage: usage(260000), prevState: tripped, history });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.trippedAt, null);
  assert.match(r.out, /open sb-circuit-breaker incident resolved/);
});

// BRO-5261 retro-review: wasEnforced is day-scoped, so a trip from an earlier
// UTC day never reached a resolve and its incident stayed open indefinitely.
test('a trip from an EARLIER day is resolved at rollover, in shadow and in enforced mode', () => {
  const yesterdayTrip = prev(250000, { day: daysBefore(1), trippedAt: `${daysBefore(1)}T20:00:00Z` });
  for (const env of [{}, { SB_BREAKER_SHADOW: '0' }]) {
    const r = run({ usage: usage(110000), prevState: yesterdayTrip, history, env });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.state.trippedAt, null);
    assert.deepEqual(r.resolves, ['sb-circuit-breaker'], `${JSON.stringify(env)}\n${r.out}`);
    assert.equal(r.alerts.length, 0);
  }
});

test('--dry-run writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdry-'));
  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SCRAPINGBEE_API_KEY: '', SB_BREAKER_STATE_PATH: path.join(dir, 's.json') } });
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 's.json')), false);
});
