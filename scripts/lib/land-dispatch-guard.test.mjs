import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideDispatchGuard, refusalMessage, cancelledAtTip, LIVE_MAX_HOURS } = require('./land-dispatch-guard.js');
const { PARK_STEP_NAME } = require('./land-mutex.js');

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-26T06:00:00Z');
const cancelled = (id, sha = TIP) => ({ id, status: 'completed', conclusion: 'cancelled', head_sha: sha, head_branch: 'land/x', run_attempt: 1 });
const checksOk = { name: 'Checks', conclusion: 'success' };
const parkedLand = { name: 'Land', conclusion: 'cancelled', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: PARK_STEP_NAME, conclusion: 'cancelled' }] };

test('refuses while a push run is queued or running', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const d = decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [{ id: 7, status, head_sha: TIP, created_at: '2026-10-26T05:00:00Z' }], now: NOW });
    assert.deepEqual(d, { allow: false, reason: 'push-run-live', runId: 7 });
    assert.doesNotMatch(refusalMessage(d, 'land/x'), /land-retry-cancelled/);
  }
});

test('a run stuck queued past LIVE_MAX_HOURS stops blocking; a re-run counts from its new start', () => {
  const old = new Date(NOW - (LIVE_MAX_HOURS + 1) * 3600000).toISOString();
  const recent = new Date(NOW - 3600000).toISOString();
  assert.equal(decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [{ id: 7, status: 'queued', created_at: old }], now: NOW }).allow, true);
  const rerun = { id: 8, status: 'queued', created_at: old, run_started_at: recent };
  assert.equal(decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [rerun], now: NOW }).reason, 'push-run-live');
});

test('refuses while the sweep would resume a cancelled run at the tip (parked or evicted)', () => {
  const evictedLand = { name: 'Land', conclusion: 'cancelled', steps: [] };
  for (const land of [parkedLand, evictedLand]) {
    const d = decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [cancelled(9)], jobsByRun: { 9: [checksOk, land] } });
    assert.equal(d.reason, 'push-run-parked');
    assert.match(refusalMessage(d, 'land/x'), /land-retry-cancelled\.js --run=9/);
  }
});

test('allows when a cancelled run at the tip is one the sweep will never resume', () => {
  const midFlight = { name: 'Land', conclusion: 'cancelled', steps: [{ name: 'Land the branch', conclusion: 'success' }] };
  const cases = [
    [{ name: 'Checks', conclusion: 'cancelled' }, parkedLand],
    [checksOk, midFlight],
    undefined,
  ];
  for (const jobs of cases) {
    const d = decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [cancelled(9)], jobsByRun: jobs ? { 9: jobs } : {} });
    assert.equal(d.allow, true, JSON.stringify(jobs));
  }
  const spent = { ...cancelled(9), run_attempt: 99 };
  assert.equal(decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [spent], jobsByRun: { 9: [checksOk, parkedLand] } }).allow, true);
});

test('only cancelled runs at the current tip get their jobs read', () => {
  const runs = [cancelled(1, OLD), cancelled(2), { id: 3, status: 'completed', conclusion: 'failure', head_sha: TIP }];
  assert.deepEqual(cancelledAtTip(runs, TIP).map((r) => r.id), [2]);
  assert.deepEqual(cancelledAtTip(runs, null), []);
});

test('refuses with a plain message when the branch is gone', () => {
  const d = decideDispatchGuard({ branch: 'land/x', tipSha: null, runs: [] });
  assert.equal(d.reason, 'branch-gone');
  assert.match(refusalMessage(d, 'land/x'), /does not exist on origin/);
});

test('allows when the only cancelled run is for an older tip, or runs finished', () => {
  const runs = [
    cancelled(1, OLD),
    { id: 2, status: 'completed', conclusion: 'failure', head_sha: TIP },
  ];
  assert.equal(decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs }).allow, true);
  assert.equal(decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [] }).allow, true);
});

test('rejects a branch input outside land/**', () => {
  for (const branch of ['main', '', 'feature/land/x', 'land/']) {
    assert.equal(decideDispatchGuard({ branch, tipSha: TIP, runs: [] }).reason, 'bad-branch');
  }
});

test('kill switch allows everything', () => {
  const d = decideDispatchGuard({ branch: 'main', tipSha: TIP, runs: [{ id: 3, status: 'in_progress' }], disabled: true });
  assert.deepEqual(d, { allow: true, reason: 'disabled' });
});
