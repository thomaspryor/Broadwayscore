/**
 * BRO-3475: a failed drift-alert delivery must not burn the 6h same-fingerprint
 * cooldown that check-opening-night-drift.js stamps at decide time.
 * Covers the pure helpers, the decide->fail->retry cycle through the real
 * shouldAlert/updateState, and the workflow's routing script executed for real
 * with a mocked routeAlert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const probe = require(path.join(ROOT, 'scripts/lib/review-count-probe.js'));
const { isAlertDeliveryFailure, rearmFailedAlert, rearmFailedAlertInFile, shouldAlert, updateState } = probe;

test('isAlertDeliveryFailure: throw or dispatchOk:false only', () => {
  assert.equal(isAlertDeliveryFailure({ threw: true }), true);
  assert.equal(isAlertDeliveryFailure({ result: { action: 'auto', dispatchOk: false } }), true);
  assert.equal(isAlertDeliveryFailure({ result: { action: 'digest' } }), false);
  assert.equal(isAlertDeliveryFailure({ result: { action: 'auto', dispatchOk: true } }), false);
  assert.equal(isAlertDeliveryFailure({ result: { action: 'silent' } }), false);
  assert.equal(isAlertDeliveryFailure(), false);
});

test('rearmFailedAlert only clears a matching, stamped entry', () => {
  const state = { a: { fingerprint: 'f1', lastAlertTs: 123, consecutiveCount: 3, aboveThreshold: true } };
  assert.equal(rearmFailedAlert(state, 'a', 'other'), false);
  assert.equal(state.a.lastAlertTs, 123);
  assert.equal(rearmFailedAlert(state, 'missing', 'f1'), false);
  assert.equal(rearmFailedAlert(state, 'a', 'f1'), true);
  assert.deepEqual(state.a, { fingerprint: 'f1', lastAlertTs: null, consecutiveCount: 3, aboveThreshold: true });
  assert.equal(rearmFailedAlert(state, 'a', 'f1'), false, 'already clear');
  assert.equal(rearmFailedAlert(null, 'a', 'f1'), false);
});

function cycleToAlert() {
  const state = {};
  const fp = 'live:7';
  // run 1 starts the grace window, run 2 alerts
  assert.equal(shouldAlert('s', fp, 5, 2, state), false);
  updateState(state, 's', fp, false, true);
  assert.equal(shouldAlert('s', fp, 5, 2, state), true);
  updateState(state, 's', fp, true, true);
  assert.ok(state.s.lastAlertTs, 'decide-time stamp present');
  return { state, fp };
}

test('failed delivery: next run inside 6h alerts again', () => {
  const { state, fp } = cycleToAlert();
  assert.equal(rearmFailedAlert(state, 's', fp), true);
  assert.equal(shouldAlert('s', fp, 5, 2, state), true);
});

test('successful delivery: cooldown still holds the next run', () => {
  const { state, fp } = cycleToAlert();
  assert.equal(shouldAlert('s', fp, 5, 2, state), false);
});

test('rearmFailedAlertInFile rewrites the file and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-rearm-'));
  const f = path.join(dir, 'drift-state.json');
  fs.writeFileSync(f, JSON.stringify({ s: { fingerprint: 'fp', lastAlertTs: 9 } }));
  assert.deepEqual(rearmFailedAlertInFile(f, 's', 'fp'), { rearmed: true, error: null });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).s.lastAlertTs, null);
  const bad = rearmFailedAlertInFile(path.join(dir, 'nope.json'), 's', 'fp');
  assert.equal(bad.rearmed, false);
  assert.ok(bad.error);
});

// --- Execute the workflow's real routing script with a mocked routeAlert ---
function routingScript() {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/check-opening-night-drift.yml'), 'utf8');
  const start = yml.indexOf('- name: Route drift alerts per show');
  const end = yml.indexOf('- name: Commit updated drift state');
  const step = yml.slice(start, end);
  const lines = step.slice(step.indexOf('script: |') + 'script: |'.length).split('\n').slice(1);
  const indent = lines.find((l) => l.trim()).match(/^\s*/)[0].length;
  return lines.map((l) => l.slice(indent)).join('\n');
}

async function runRouting({ rows, state, routeAlert }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-wf-'));
  fs.mkdirSync(path.join(dir, 'data/audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/audit/drift-state.json'), JSON.stringify(state));
  const results = path.join(dir, 'drift-results.json');
  fs.writeFileSync(results, JSON.stringify(rows));
  const warnings = [];
  const mockRequire = (id) => {
    if (id === 'fs') {
      return { ...fs, readFileSync: (p, ...a) => fs.readFileSync(p === '/tmp/drift-results.json' ? results : p, ...a) };
    }
    if (id.endsWith('owner-alert-router.js')) return { routeAlert, resolveCondition: () => false };
    if (id.endsWith('review-count-probe.js')) {
      return { ...probe, rearmFailedAlertInFile: (f, ...a) => probe.rearmFailedAlertInFile(path.join(dir, f), ...a) };
    }
    return require(id);
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('require', 'core', 'context', routingScript());
  const log = console.log;
  console.log = () => {};
  try {
    await fn(mockRequire, { warning: (m) => warnings.push(m) }, { repo: { owner: 'o', repo: 'r' }, runId: 1 });
  } finally {
    console.log = log;
  }
  return { state: JSON.parse(fs.readFileSync(path.join(dir, 'data/audit/drift-state.json'), 'utf8')), warnings };
}

const row = (showId, extra = {}) => ({ showId, title: showId, alert: true, fingerprint: 'fp', effectiveDrift: 5, drift: 5, threshold: 2, local: 5, aggregate: 5, live: 0, ...extra });
const stamped = () => ({ a: { fingerprint: 'fp', lastAlertTs: 111, aboveThreshold: true, consecutiveCount: 2 }, b: { fingerprint: 'fp', lastAlertTs: 222, aboveThreshold: true, consecutiveCount: 2 }, c: { fingerprint: 'fp', lastAlertTs: 333, aboveThreshold: true, consecutiveCount: 2 } });

test('workflow routing: dispatchOk:false and a throw re-arm; success keeps the stamp', async () => {
  const { state, warnings } = await runRouting({
    rows: [row('a'), row('b'), row('c')],
    state: stamped(),
    routeAlert: async ({ conditionKey }) => {
      if (conditionKey.endsWith(':a')) return { action: 'auto', dispatchOk: false, dispatchError: 'LINEAR_API_KEY not set' };
      if (conditionKey.endsWith(':b')) throw new Error('resend down');
      return { action: 'digest' };
    },
  });
  assert.equal(state.a.lastAlertTs, null);
  assert.equal(state.b.lastAlertTs, null);
  assert.equal(state.c.lastAlertTs, 333);
  assert.ok(warnings.some((w) => /:a delivery failed — drift-state cooldown re-armed/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /:b delivery failed — drift-state cooldown re-armed/.test(w)), warnings.join('\n'));
});

test('workflow routing: non-alerting rows never touch drift-state', async () => {
  const { state } = await runRouting({
    rows: [row('a', { alert: false })],
    state: stamped(),
    routeAlert: async () => { throw new Error('must not be called'); },
  });
  assert.equal(state.a.lastAlertTs, 111);
});
