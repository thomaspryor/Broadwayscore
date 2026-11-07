// BRO-5261 retro-review: the SD and BD breaker checkers decide "was tripped"
// with a day-scoped helper, so a trip on an earlier UTC day was never seen
// as a change at rollover and its alert-ledger incident stayed open
// indefinitely (sd-circuit-breaker sat open from 2026-09-06). Drives the real
// scripts with billing and the alert router stubbed via a -r preload; every
// state/ledger path redirected into a temp dir. The SB checker's twin case is
// in check-sb-breaker.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

function run(script, { stub, state, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-rollover-'));
  const statePath = path.join(dir, 'state.json');
  const resolves = path.join(dir, 'resolves.txt');
  const alerts = path.join(dir, 'alerts.txt');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const billing = require(${JSON.stringify(path.join(ROOT, 'scripts/lib/provider-billing.js'))});
    ${stub}
    const routerPath = require.resolve(${JSON.stringify(path.join(ROOT, 'scripts/lib/owner-alert-router.js'))});
    require.cache[routerPath] = { id: routerPath, filename: routerPath, loaded: true, exports: {
      routeAlert: async (a) => { fs.appendFileSync(${JSON.stringify(alerts)}, a.conditionKey + '\\n'); },
      resolveCondition: (k) => { fs.appendFileSync(${JSON.stringify(resolves)}, k + '\\n'); return true; },
    } };
  `);
  const res = spawnSync(process.execPath, ['-r', preload, path.join(ROOT, 'scripts', script)], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, BREAKER_TRANSITIONS_PATH: path.join(dir, 't.jsonl'), ...env(statePath) },
  });
  const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
  return { code: res.status, out: `${res.stdout}${res.stderr}`, resolves: lines(resolves), alerts: lines(alerts) };
}

test('SD: a trip from yesterday is resolved on the first untripped run today', () => {
  const r = run('check-sd-breaker.js', {
    stub: 'billing.fetchSdAccount = async () => ({ cycleUsed: 100500, limit: 1000000, daysToRenewal: 20 });',
    state: { day: yesterday, dayBaseline: 50000, lastCycleUsed: 100000, trippedAt: `${yesterday}T20:00:00Z` },
    env: (p) => ({ SCRAPINGDOG_API_KEY: 'test', SD_BREAKER_STATE_PATH: p, SD_BREAKER_CEILING: '' }),
  });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.resolves, ['sd-circuit-breaker'], r.out);
  assert.deepEqual(r.alerts, []);
});

test('BD: each zone tripped yesterday and quiet today is resolved', () => {
  const r = run('check-bd-breaker.js', {
    stub: 'billing.fetchBdZoneCostDay = async () => ({ reqs: 3, cost: 0.01 });',
    state: { zones: {
      web_unlocker2: { day: yesterday, trippedAt: `${yesterday}T20:00:00Z`, billedReqs: 9999, ceiling: 250 },
      serp_api1: { day: yesterday, trippedAt: null, billedReqs: 1, ceiling: 250 },
    } },
    env: (p) => ({ BRIGHTDATA_TOKEN: 'test', BD_BREAKER_STATE_PATH: p, BD_BREAKER_CEILING: '', BRIGHTDATA_ZONE: '', BRIGHTDATA_SERP_ZONE: '' }),
  });
  assert.equal(r.code, 0, r.out);
  // serp_api1 is resolved too: a no-op in the real router when nothing is open.
  assert.deepEqual(r.resolves.sort(), ['bd-circuit-breaker-serp_api1', 'bd-circuit-breaker-web_unlocker2'], r.out);
  assert.deepEqual(r.alerts, []);
});
