import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchDecision, activeWindows, LAUNCH_INFLIGHT_GRACE_SEC } from '../../scripts/lib/opening-night-windows.js';

// Card #650: the launcher previously opened a cmux workspace to run the
// monitor — cmux refuses connections from launchd-parented process ancestry
// ("Access denied — only processes started inside cmux can connect" /
// broken-pipe on list-workspaces/new-workspace), which is why the launcher
// launched a session 0/344 times. The fix runs the monitor headless via
// scripts/lib/opening-night-monitor.js (a thin wrapper around the shared
// scripts/lib/claude-cli.js primitive already used by autonomous-run.js and
// bsc-runner.js under this exact launchd ancestry) and never touches cmux at
// all. This is a structural regression guard — it fails if the launcher ever
// re-imports the ancestry-sensitive cmux path, not just if it's called.
test('launcher never imports the cmux launch/workspace modules', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/lib\/cmux-launch\.js['"]\)/, 'launcher must not require cmux-launch.js — that is the ancestry-sensitive path card #650 removed');
  assert.doesNotMatch(src, /require\(['"]\.\/lib\/cmux-workspaces\.js['"]\)/, 'launcher must not require cmux-workspaces.js — no cmux workspace exists to probe in the headless design');
  assert.match(src, /require\(['"]\.\/lib\/opening-night-monitor\.js['"]\)/, 'launcher must run the pass through the headless wrapper');
});

// Adversarial ship-check finding (2026-07-30): a lock that needs reclaiming
// means the PREVIOUS pass's node process died mid-flight (SIGKILL/OOM/sleep)
// before it ever reached its own success/failure write. Without counting
// that as a failure, a string of process-level crashes could reclaim forever
// (every ~90 min, HEARTBEAT_STALE_MIN) without ever reaching
// MAX_ATTEMPTS_PER_NIGHT and paging the owner — the exact silent-forever
// failure mode this regression guard exists to catch.
test('reclaim-and-launch counts the abandoned attempt as a consecutive failure', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const reclaimBlock = src.slice(src.indexOf("decision.action === 'reclaim-and-launch'"));
  const nextBlockEnd = reclaimBlock.indexOf('\n  }\n');
  const block = reclaimBlock.slice(0, nextBlockEnd);
  assert.match(block, /consecutiveFailures:\s*\(nightState\.consecutiveFailures\s*\|\|\s*0\)\s*\+\s*1/, 'reclaim-and-launch must increment consecutiveFailures for the abandoned attempt');
  assert.match(block, /writeNightState\(key,\s*nightState\)/, 'the incremented consecutiveFailures must be persisted before the new attempt proceeds');
});

// Card #568: LOCK_DIR is the atomic test-and-set (mkdir, before the launch
// even starts) but LOCK_META is only written AFTER launchCmuxSession()
// resolves — up to verifyTimeoutSec(90) x 2 attempts + lateAdoptSec(60) =
// ~240s later. A concurrent tick that lands inside that gap sees
// lockExists=true, metaExists=false, claudeAlive=false — the exact same
// shape as a launch that died before ever writing meta. Without a lock-age
// signal, launchDecision can't tell "still launching" from "long dead" and
// reclaims a still-in-flight session out from under it.
//
// heartbeatAgeMin is deliberately set to a large-but-realistic number here,
// not null: HEARTBEAT is a single global file a prior night's session
// already wrote and nothing deletes, so in production it is essentially
// never null — an earlier version of this fix keyed off
// heartbeatAgeMin===null and was unreachable as a result (ship-check
// finding). metaExists is the signal that actually distinguishes in-flight
// from pre-meta-dead.
test('a launch actively in flight (fresh lock, no meta.json yet) is NOT reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: 10, // fresh lock — well inside the grace window
    metaExists: false,
  });
  assert.notEqual(d.action, 'reclaim-and-launch');
  assert.equal(d.action, 'skip');
});

test('a lock that outlived the grace window with no meta.json IS reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: LAUNCH_INFLIGHT_GRACE_SEC + 30,
    metaExists: false,
  });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Guards the launcher's own wiring: main() must actually compute and pass
// lockAgeSec + metaExists into launchDecision's state, or the grace window
// above is dead code that never fires against real ticks (same silent-
// revert risk as the claudeAlive guard above).
test('launcher state object passes lockAgeSec through to launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const lockAgeLine = src.split('\n').find(l => l.includes('lockAgeSec:'));
  assert.ok(lockAgeLine, 'expected a `lockAgeSec:` field in the state object literal');
  assert.match(lockAgeLine, /lockAgeSec\(\)/, 'lockAgeSec must be computed from LOCK_DIR birthtime, not hardcoded/omitted');
});

test('launcher state object passes metaExists through to launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const metaExistsLine = src.split('\n').find(l => l.includes('metaExists:'));
  assert.ok(metaExistsLine, 'expected a `metaExists:` field in the state object literal — the in-flight grace window must key off whether THIS lock instance has written meta.json, not the global (never-null-in-practice) heartbeat file');
});

// Regression guard: the in-flight check must never key off heartbeatAgeMin,
// even indirectly — that was the exact bug an earlier version of this fix
// shipped with (heartbeatAgeMin is realistically never null in production).
test('lockAgeSec is computed from birthtime, not mtime (mtime is reset by unrelated writes into the lock dir)', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const lockAgeFn = src.slice(src.indexOf('function lockAgeSec'), src.indexOf('function lockAgeSec') + 300);
  assert.match(lockAgeFn, /birthtimeMs/, 'lockAgeSec must use birthtimeMs, not mtimeMs');
});
