import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  CONSECUTIVE_FAILURE_THRESHOLD,
  CONDITION_KEY,
  logReachabilityAttempt,
  readReachabilityAttempts,
  decideReachabilityAlert,
  probeCmuxReachability,
  runReachabilityCheck,
} = require('../lib/cmux-reachability-check.js');

// BRO-2992: nothing asserted cmux socket reachability directly, so the
// 2026-09-07 BRO-2959 auth migration disabled bsc-reconcile's tab self-heal,
// bsc-prune, and dispatch-watchdog simultaneously for ~2h with nothing
// paging. These tests cover the shared decision logic (streak-gated
// alerting) both scripts/check-cmux-reachability.js and health-check.js's
// checkCmuxReachability() rely on.

function tmpLogPath() {
  return path.join(os.tmpdir(), `cmux-reachability-test-${randomUUID()}.jsonl`);
}

test('decideReachabilityAlert stays quiet below the consecutive-failure threshold', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const attempts = [
    { ts: '2026-09-07T11:30:00Z', ok: false },
    { ts: '2026-09-07T11:45:00Z', ok: false },
  ];
  const decision = decideReachabilityAlert(attempts, { now });
  assert.equal(decision.consecutiveFailures, 2);
  assert.equal(decision.shouldAlert, false);
});

test('decideReachabilityAlert fires once the streak reaches the threshold', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const attempts = Array.from({ length: CONSECUTIVE_FAILURE_THRESHOLD }, (_, i) => ({
    ts: new Date(now - (CONSECUTIVE_FAILURE_THRESHOLD - i) * 15 * 60 * 1000).toISOString(),
    ok: false,
  }));
  const decision = decideReachabilityAlert(attempts, { now });
  assert.equal(decision.consecutiveFailures, CONSECUTIVE_FAILURE_THRESHOLD);
  assert.equal(decision.shouldAlert, true);
});

test('decideReachabilityAlert resets the streak on a healthy attempt', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const attempts = [
    { ts: '2026-09-07T10:00:00Z', ok: false },
    { ts: '2026-09-07T10:15:00Z', ok: false },
    { ts: '2026-09-07T10:30:00Z', ok: true },
  ];
  const decision = decideReachabilityAlert(attempts, { now });
  assert.equal(decision.consecutiveFailures, 0);
  assert.equal(decision.shouldAlert, false);
});

test('logReachabilityAttempt + readReachabilityAttempts round-trip in chronological order', () => {
  const logPath = tmpLogPath();
  try {
    logReachabilityAttempt({ ok: false, error: 'timeout' }, { logPath, now: Date.parse('2026-09-07T10:00:00Z') });
    logReachabilityAttempt({ ok: false, error: 'timeout' }, { logPath, now: Date.parse('2026-09-07T10:15:00Z') });
    logReachabilityAttempt({ ok: true }, { logPath, now: Date.parse('2026-09-07T10:30:00Z') });

    const attempts = readReachabilityAttempts({ logPath });
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((a) => a.ok), [false, false, true]);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test('readReachabilityAttempts prunes entries older than the retention window', () => {
  const logPath = tmpLogPath();
  try {
    const now = Date.parse('2026-09-07T12:00:00Z');
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    logReachabilityAttempt({ ok: false }, { logPath, now: eightDaysAgo });
    logReachabilityAttempt({ ok: false }, { logPath, now });

    const attempts = readReachabilityAttempts({ logPath, days: 7 });
    assert.equal(attempts.length, 1);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test('probeCmuxReachability reports unmeasurable when cmux is not installed', () => {
  const result = probeCmuxReachability({ cmuxAvailableFn: () => false });
  assert.equal(result.measurable, false);
});

test('probeCmuxReachability treats an empty workspace list as unreachable (existing cmux-workspaces.js convention)', () => {
  const result = probeCmuxReachability({ cmuxAvailableFn: () => true, listWorkspacesFn: () => [] });
  assert.equal(result.measurable, true);
  assert.equal(result.reachable, false);
});

test('probeCmuxReachability treats a thrown listWorkspaces() as unreachable, not a crash', () => {
  const result = probeCmuxReachability({
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => { throw new Error('ERROR: Access denied'); },
  });
  assert.equal(result.measurable, true);
  assert.equal(result.reachable, false);
  assert.match(result.error, /Access denied/);
});

test('probeCmuxReachability reports reachable when workspaces come back', () => {
  const result = probeCmuxReachability({ cmuxAvailableFn: () => true, listWorkspacesFn: () => [{ ref: 'workspace:1' }] });
  assert.equal(result.measurable, true);
  assert.equal(result.reachable, true);
  assert.equal(result.workspaceCount, 1);
});

test('runReachabilityCheck: unmeasurable environment (CI / no cmux.app) never calls the alert router', async () => {
  let alertCalled = false;
  const row = await runReachabilityCheck({
    logPath: tmpLogPath(),
    probeFn: () => ({ measurable: false }),
    routeAlertFn: async () => { alertCalled = true; },
    resolveConditionFn: () => {},
  });
  assert.match(row.name, /\(unmeasurable here\)$/);
  assert.equal(row.status, 'warn');
  assert.equal(alertCalled, false);
});

test('runReachabilityCheck: healthy run is silent and resolves any open incident', async () => {
  const logPath = tmpLogPath();
  let alertCalled = false;
  let resolvedKey = null;
  try {
    const row = await runReachabilityCheck({
      logPath,
      probeFn: () => ({ measurable: true, reachable: true, workspaceCount: 3, error: null }),
      routeAlertFn: async () => { alertCalled = true; },
      resolveConditionFn: (key) => { resolvedKey = key; },
    });
    assert.equal(row.status, 'pass');
    assert.equal(alertCalled, false);
    assert.equal(resolvedKey, CONDITION_KEY);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test('runReachabilityCheck: below-threshold failures stay quiet (single owner alert, not one per run)', async () => {
  const logPath = tmpLogPath();
  let alertCount = 0;
  try {
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD - 1; i++) {
      // eslint-disable-next-line no-await-in-loop
      const row = await runReachabilityCheck({
        logPath,
        now: Date.parse('2026-09-07T10:00:00Z') + i * 15 * 60 * 1000,
        probeFn: () => ({ measurable: true, reachable: false, workspaceCount: 0, error: 'timeout' }),
        routeAlertFn: async () => { alertCount++; },
        resolveConditionFn: () => {},
      });
      assert.equal(row.status, 'warn');
    }
    assert.equal(alertCount, 0);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test('runReachabilityCheck: crossing the threshold pages exactly once', async () => {
  const logPath = tmpLogPath();
  let alertCount = 0;
  let lastRow = null;
  try {
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      // eslint-disable-next-line no-await-in-loop
      lastRow = await runReachabilityCheck({
        logPath,
        now: Date.parse('2026-09-07T10:00:00Z') + i * 15 * 60 * 1000,
        probeFn: () => ({ measurable: true, reachable: false, workspaceCount: 0, error: 'ERROR: Access denied' }),
        routeAlertFn: async () => { alertCount++; },
        resolveConditionFn: () => {},
      });
    }
    assert.equal(alertCount, 1);
    assert.equal(lastRow.status, 'error');
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});

test('runReachabilityCheck: dryRun never writes the attempts log or pages', async () => {
  const logPath = tmpLogPath();
  let alertCalled = false;
  try {
    await runReachabilityCheck({
      dryRun: true,
      logPath,
      probeFn: () => ({ measurable: true, reachable: false, workspaceCount: 0, error: 'timeout' }),
      routeAlertFn: async () => { alertCalled = true; },
      resolveConditionFn: () => {},
    });
    assert.equal(alertCalled, false);
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
