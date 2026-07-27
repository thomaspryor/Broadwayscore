import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launchDecision, activeWindows, LAUNCH_INFLIGHT_GRACE_SEC } from '../../scripts/lib/opening-night-windows.js';

const require = createRequire(import.meta.url);
const { shouldAdoptLateStart } = require('../../scripts/opening-night-monitor-launch.js');

// Card #567: the fix replaced a bare claudeAliveIn(ref) call (single-signal,
// same registry-desync false-negative as #559/#564) with
// cmuxws.computeClaudeAlive(meta), which requires the independent
// terminal-surface signal to ALSO agree "dead" (checkLiveness, card
// #559/#564) before reporting the locked session not-alive. The lib-level
// tests in scripts/lib/cmux-workspaces.test.mjs and
// scripts/lib/opening-night-windows.test.mjs prove computeClaudeAlive's
// logic is correct in isolation, but main()'s call to cmuxws.computeClaudeAlive
// isn't independently exercised elsewhere — main() reads MON_DIR/monitor.lock
// from the real repo path, so a full in-process integration test would have
// to mutate real on-disk state to drive it. This source-level guard is the
// cheap alternative: it fails if the call site ever regresses back to a bare
// claudeAliveIn(...) — the exact silent-revert this class of bug keeps
// recurring as (a different call site each time: #559 pruneDone, #564
// checkDeadDispatch, #567 here).
test('claudeAlive computation calls computeClaudeAlive, not a bare claudeAliveIn', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const claudeAliveLine = src.split('\n').find(l => l.includes('claudeAlive:'));
  assert.ok(claudeAliveLine, 'expected a `claudeAlive:` field in the state object literal');
  assert.match(claudeAliveLine, /cmuxws\.computeClaudeAlive\(/, 'claudeAlive must go through computeClaudeAlive (both liveness signals), not claudeAliveIn alone');
  assert.doesNotMatch(claudeAliveLine, /\bclaudeAliveIn\(/, 'claudeAlive must not call claudeAliveIn directly — that is the single-signal false-negative this card fixed');
});

// Regression for the 2026-07-24 false CRITICAL: a Fable session that comes
// alive AFTER launchCmuxSession's verify window is healthy, not failed — the
// launcher must adopt it (and NOT page + relaunch a duplicate).
test('adopts a failed launch whose workspace is actually alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:272', reason: 'no running claude ... after 2 attempts' };
  assert.equal(shouldAdoptLateStart(result, true), true);
});

test('does NOT adopt when the workspace never comes alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:272', reason: 'no running claude ... after 2 attempts' };
  assert.equal(shouldAdoptLateStart(result, false), false);
});

test('does NOT adopt when there is no workspace to adopt', () => {
  const result = { ok: false, reason: 'cmux CLI not found' };
  assert.equal(shouldAdoptLateStart(result, true), false);
});

test('a genuine success is not an adoption case', () => {
  const result = { ok: true, ref: 'workspace:272' };
  assert.equal(shouldAdoptLateStart(result, true), false);
});

// Card #568: LOCK_DIR is the atomic test-and-set (mkdir, before the launch
// even starts) but LOCK_META and the heartbeat are both only written AFTER
// launchCmuxSession() resolves — up to verifyTimeoutSec(90) + lateAdoptSec(60)
// = 150s later. A concurrent tick that lands inside that gap sees
// lockExists=true, meta=null (heartbeatAgeMin=null, claudeAlive=false) — the
// exact same shape as a launch that died before ever writing meta. Without a
// lock-age signal, launchDecision can't tell "still launching" from "long
// dead" and reclaims a still-in-flight session out from under it.
test('a launch actively in flight (fresh lock, no meta/heartbeat yet) is NOT reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: null, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: 10, // fresh lock — well inside the grace window
  });
  assert.notEqual(d.action, 'reclaim-and-launch');
  assert.equal(d.action, 'skip');
});

test('a lock that outlived the grace window with no meta/heartbeat IS reclaimed', () => {
  const windows = activeWindows(
    [{ id: 'giant-2026', category: 'broadway', openingDate: '2026-07-30' }],
    new Date('2026-07-30T22:00:00Z'),
  );
  const d = launchDecision({
    windows, killSwitch: false, lockExists: true,
    heartbeatAgeMin: null, claudeAlive: false, attemptsTonight: 0,
    lockAgeSec: LAUNCH_INFLIGHT_GRACE_SEC + 30,
  });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Guards the launcher's own wiring: main() must actually compute and pass
// lockAgeSec into launchDecision's state, or the grace window above is dead
// code that never fires against real ticks (same silent-revert risk as the
// claudeAlive guard above).
test('launcher state object passes lockAgeSec through to launchDecision', () => {
  const src = readFileSync(new URL('../../scripts/opening-night-monitor-launch.js', import.meta.url), 'utf8');
  const lockAgeLine = src.split('\n').find(l => l.includes('lockAgeSec:'));
  assert.ok(lockAgeLine, 'expected a `lockAgeSec:` field in the state object literal');
  assert.match(lockAgeLine, /lockAgeSec\(\)/, 'lockAgeSec must be computed from LOCK_DIR mtime, not hardcoded/omitted');
});
