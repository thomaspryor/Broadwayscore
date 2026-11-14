// BRO-3058: exercise the shared consumer behind the dead-rate audit and digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDeadRate, computeDispatchHealthDigest } = require('./dispatch-health.js');
const { JOB_EVENTS } = require('./dispatch-ledger.js');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const TS = '2026-10-10T12:00:00Z';
const failure = (event, extra = {}) => ({ ts: TS, event, taskId: 'BRO-3058', ...extra });

test('audit separates signalled job/monitor failures from failure rows without exitSignal', () => {
  // Writer shapes: job-failed has a jobId; monitor launch-failed has no
  // launch/workspaceRef and uses the night key as taskId. Neither needs a
  // matching launch to contribute to this ROW count.
  const entries = [
    failure(JOB_EVENTS.FAILED, { jobId: 'job-3058', exitSignal: 'SIGKILL' }),
    failure('launch-failed', { taskId: '2026-10-10', kind: 'on-monitor', exitSignal: 'SIGKILL' }),
    failure('launch-failed', { taskId: '2026-10-09', exitSignal: 'SIGTERM' }),
    failure(JOB_EVENTS.FAILED, { exitCode: 1 }),
    failure('launch-failed', { exitSignal: null }),
    failure('dead', { workspaceRef: 'workspace:1' }),
  ];
  const stats = computeDeadRate(entries, { nowMs: NOW });
  assert.deepEqual(stats.failureRows, {
    total: 6, osKilled: 3, noExitSignal: 3, byExitSignal: { SIGKILL: 2, SIGTERM: 1 },
  });
  assert.equal(stats.launches, 0, 'failure rows must not invent launch attempts');
  assert.equal(stats.dead, 0, 'unattributed deaths must not change the rate');
  const row = computeDispatchHealthDigest({ entries, nowMs: NOW });
  assert.deepEqual(row.failureRows, stats.failureRows);
  assert.equal(row.status, 'warn');
  assert.match(row.message, /all lanes, last 7d/);
  assert.match(row.message, /3 OS-killed/);
  assert.match(row.message, /SIGKILL: 2/);
  assert.match(row.message, /SIGTERM: 1/);
  assert.match(row.message, /3 without exitSignal/);
});

test('failure rows are scoped by their own timestamp and only failure/dead events count', () => {
  const entries = [
    failure(JOB_EVENTS.FAILED, { ts: '2026-10-04T12:00:00Z', exitSignal: 'SIGKILL' }),
    failure('launch-failed', { ts: new Date(NOW).toISOString(), exitSignal: 'SIGTERM' }),
    failure('dead', { ts: '2026-10-04T11:59:59Z', exitSignal: 'SIGKILL' }),
    failure('launch-failed', { ts: '2026-10-11T12:00:01Z', exitSignal: 'SIGKILL' }),
    failure(JOB_EVENTS.FAILED, { ts: 'invalid', exitSignal: 'SIGKILL' }),
    failure(JOB_EVENTS.FAILED, { ts: undefined, exitSignal: 'SIGKILL' }),
    ...['launch', JOB_EVENTS.DONE, JOB_EVENTS.SPAWNED, JOB_EVENTS.ORPHANED,
      JOB_EVENTS.BLOCKED, 'prune-closed'].map(event => failure(event, { exitSignal: 'SIGKILL' })),
    null,
  ];
  assert.deepEqual(computeDeadRate(entries, { nowMs: NOW }).failureRows, {
    total: 2, osKilled: 2, noExitSignal: 0, byExitSignal: { SIGKILL: 1, SIGTERM: 1 },
  });
});

test('legacy and empty signals are counted without claiming an OS kill', () => {
  const entries = [undefined, null, '', ' ', false].map(exitSignal =>
    failure(JOB_EVENTS.FAILED, { exitSignal }));
  assert.deepEqual(computeDeadRate(entries, { nowMs: NOW }).failureRows, {
    total: 5, osKilled: 0, noExitSignal: 5, byExitSignal: {},
  });
  assert.deepEqual(computeDeadRate([], { nowMs: NOW }).failureRows, {
    total: 0, osKilled: 0, noExitSignal: 0, byExitSignal: {},
  });
});

test('every digest status surfaces failure rows without changing the lane rate or severity', () => {
  const entries = [
    failure('launch', { workspaceRef: 'workspace:1' }),
    failure('dead', { workspaceRef: 'workspace:1' }),
    failure(JOB_EVENTS.FAILED, { exitSignal: 'SIGKILL' }),
  ];
  for (const [options, expectedStatus] of [
    [{ deadRateFloor: 1 }, 'pass'],
    [{ deadRateFloor: 0, minLaunches: 2 }, 'warn'],
    [{ deadRateFloor: 0, minLaunches: 1 }, 'error'],
  ]) {
    const row = computeDispatchHealthDigest({ entries, nowMs: NOW, ...options });
    assert.equal(row.status, expectedStatus);
    assert.equal(row.deadRate, 1);
    assert.equal(row.launches, 1);
    assert.deepEqual(row.failureRows, {
      total: 2, osKilled: 1, noExitSignal: 1, byExitSignal: { SIGKILL: 1 },
    });
    assert.match(row.message, /1 OS-killed/);
    assert.match(row.message, /1 without exitSignal/);
  }
});

test('all-lane failure row counts stay independent of the selected dead-rate lane', () => {
  const entries = [failure('launch-failed', { kind: 'on-monitor', exitSignal: 'SIGKILL' })];
  for (const lane of ['workspace', 'headless', 'other']) {
    const row = computeDispatchHealthDigest({ entries, nowMs: NOW, lane });
    assert.equal(row.failureRows.osKilled, 1);
    assert.equal(row.launches, 0);
    assert.match(row.message, /all lanes/);
  }
});
