import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideDispatchGuard, refusalMessage } = require('./land-dispatch-guard.js');

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

test('refuses while a push run is queued or running', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const d = decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [{ id: 7, status, head_sha: TIP }] });
    assert.deepEqual(d, { allow: false, reason: 'push-run-live', runId: 7 });
  }
});

test('refuses while a push run is parked (cancelled at the current tip)', () => {
  const d = decideDispatchGuard({ branch: 'land/x', tipSha: TIP, runs: [{ id: 9, status: 'completed', conclusion: 'cancelled', head_sha: TIP }] });
  assert.equal(d.reason, 'push-run-parked');
  assert.match(refusalMessage(d, 'land/x'), /land-retry-cancelled\.js --run=9/);
});

test('allows when the only cancelled run is for an older tip, or runs finished', () => {
  const runs = [
    { id: 1, status: 'completed', conclusion: 'cancelled', head_sha: OLD },
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
