import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  utcFromZoned, computeWindow, activeWindows, nightKey, launchDecision,
  HEARTBEAT_STALE_MIN, MAX_ATTEMPTS_PER_NIGHT, LAUNCH_INFLIGHT_GRACE_SEC,
  claimLockGeneration, isLockGenerationOwner, shouldPageForFailedPass,
} from './opening-night-windows.js';
import { computeClaudeAlive } from './cmux-workspaces.js';

// ── timezone math ──────────────────────────────────────────────────────────

test('utcFromZoned: Broadway 17:00 ET in July is 21:00 UTC (EDT)', () => {
  assert.equal(utcFromZoned('2026-07-30', 17, 0, 'America/New_York').toISOString(), '2026-07-30T21:00:00.000Z');
});

test('utcFromZoned: Broadway 17:00 ET in January is 22:00 UTC (EST)', () => {
  assert.equal(utcFromZoned('2026-01-15', 17, 0, 'America/New_York').toISOString(), '2026-01-15T22:00:00.000Z');
});

test('utcFromZoned: West End 17:00 UK in July is 16:00 UTC (BST)', () => {
  assert.equal(utcFromZoned('2026-07-30', 17, 0, 'Europe/London').toISOString(), '2026-07-30T16:00:00.000Z');
});

test('utcFromZoned: West End 17:00 UK in January is 17:00 UTC (GMT)', () => {
  assert.equal(utcFromZoned('2026-01-15', 17, 0, 'Europe/London').toISOString(), '2026-01-15T17:00:00.000Z');
});

test('utcFromZoned: US fall-back day (Nov 1 2026) resolves without drift', () => {
  // 2026-11-01 17:00 ET is after the 02:00 fall-back → EST (UTC-5) → 22:00 UTC.
  assert.equal(utcFromZoned('2026-11-01', 17, 0, 'America/New_York').toISOString(), '2026-11-01T22:00:00.000Z');
});

// ── window computation ─────────────────────────────────────────────────────

const TAO = { id: 'tao-of-glass-west-end-2026', category: 'west-end', openingDate: '2026-07-30' };
const BWAY = { id: 'school-girls-2026', category: 'broadway', openingDate: '2026-09-08' };

test('computeWindow: WE window spans openingDate 17:00 UK → next day 23:59 UK', () => {
  const w = computeWindow(TAO);
  assert.equal(w.windowStart.toISOString(), '2026-07-30T16:00:00.000Z');
  assert.equal(w.windowEnd.toISOString(), '2026-07-31T22:59:00.000Z');
});

test('computeWindow: null for OB/regional/missing/malformed openingDate', () => {
  assert.equal(computeWindow({ id: 'x', category: 'off-broadway', openingDate: '2026-07-30' }), null);
  assert.equal(computeWindow({ id: 'x', category: 'broadway', openingDate: null }), null);
  assert.equal(computeWindow({ id: 'x', category: 'broadway', openingDate: 'TBD' }), null);
  assert.equal(computeWindow({ id: 'x', category: 'regional', openingDate: '2026-07-30' }), null);
});

test('activeWindows: selects only shows whose window contains now — ignores status/trust fields entirely', () => {
  const shows = [
    { ...TAO, status: 'announced', openingDateSource: 'todaytix' }, // untrusted + weird status: still selected
    BWAY,
    { id: 'old', category: 'west-end', openingDate: '2026-07-20' },
  ];
  const during = activeWindows(shows, new Date('2026-07-30T20:00:00Z'));
  assert.deepEqual(during.map(w => w.showId), ['tao-of-glass-west-end-2026']);
  const before = activeWindows(shows, new Date('2026-07-30T10:00:00Z'));
  assert.equal(before.length, 0);
  const morningAfter = activeWindows(shows, new Date('2026-07-31T11:00:00Z'));
  assert.deepEqual(morningAfter.map(w => w.showId), ['tao-of-glass-west-end-2026']);
  const after = activeWindows(shows, new Date('2026-08-01T00:00:00Z'));
  assert.equal(after.length, 0);
});

test('activeWindows: consecutive-day openings overlap into one active set', () => {
  const shows = [
    { id: 'a', category: 'west-end', openingDate: '2026-07-30' },
    { id: 'b', category: 'west-end', openingDate: '2026-07-31' },
  ];
  const overlap = activeWindows(shows, new Date('2026-07-31T18:00:00Z'));
  assert.deepEqual(overlap.map(w => w.showId), ['a', 'b']);
  assert.equal(nightKey(overlap), 'on-monitor-2026-07-30');
});

// ── launch decision table ──────────────────────────────────────────────────

const IN_WINDOW = activeWindows([TAO], new Date('2026-07-30T20:00:00Z'));
const base = { windows: IN_WINDOW, killSwitch: false, lockExists: false, heartbeatAgeMin: null, claudeAlive: false, attemptsTonight: 0 };

test('decision: kill switch beats everything', () => {
  assert.equal(launchDecision({ ...base, killSwitch: true }).action, 'skip');
});

test('decision: no active window → skip', () => {
  assert.equal(launchDecision({ ...base, windows: [] }).action, 'skip');
});

test('decision: fresh night → launch', () => {
  assert.equal(launchDecision(base).action, 'launch');
});

test('decision: THE duplicate-launch trap — sleeping session (no process, fresh heartbeat) is NOT relaunched', () => {
  // A session idle between census passes has no running claude process.
  // Relaunching would put two Fable sessions in the same tree (pre-mortem
  // primary scenario). Heartbeat freshness must win over the process probe.
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 45, claudeAlive: false });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /heartbeat/);
});

test('decision: stale heartbeat but live process → skip (long tool call)', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: HEARTBEAT_STALE_MIN + 30, claudeAlive: true });
  assert.equal(d.action, 'skip');
});

test('decision: stale heartbeat + no process → reclaim and relaunch', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: HEARTBEAT_STALE_MIN + 30, claudeAlive: false, attemptsTonight: 1 });
  assert.equal(d.action, 'reclaim-and-launch');
});

test('decision: lock present but heartbeat never written (launch died pre-loop) → stale path applies', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: null, claudeAlive: false, attemptsTonight: 1 });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Card #567: opening-night-monitor-launch.js used to compute claudeAlive via
// a bare claudeAliveIn(ref) — the same single-signal trust that #559/#564
// proved has a real false-negative mode. Feeding that straight into
// launchDecision meant a session sleeping through a long tool call (stale
// heartbeat, primary registry falsely says dead) would be treated as dead
// and get 'reclaim-and-launch' — a duplicate babysitter session launched on
// top of one that is still alive and working. computeClaudeAlive requires
// the independent terminal-surface signal to ALSO say dead before reporting
// not-alive, so this end-to-end wiring must resolve to 'skip'.
test('decision: end-to-end via computeClaudeAlive — stale heartbeat + registry desync (primary dead, surface alive) → skip, NOT reclaim-and-launch', () => {
  const claudeAlive = computeClaudeAlive({ workspaceRef: 'workspace:1' }, {
    claudeAliveIn: () => false,        // primary registry falsely says dead
    terminalSurfaceAliveIn: () => true, // surface registry: still alive
  });
  assert.equal(claudeAlive, true);
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: HEARTBEAT_STALE_MIN + 30, claudeAlive });
  assert.equal(d.action, 'skip');
});

test('decision: end-to-end via computeClaudeAlive — stale heartbeat + both signals agree dead → reclaim-and-launch', () => {
  const claudeAlive = computeClaudeAlive({ workspaceRef: 'workspace:1' }, {
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => false,
  });
  assert.equal(claudeAlive, false);
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: HEARTBEAT_STALE_MIN + 30, claudeAlive, attemptsTonight: 1 });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Card #568: LOCK_META (meta.json) is written only AFTER launchCmuxSession()
// returns, up to ~240s later — a concurrent tick landing in that gap sees
// lockExists=true, metaExists=false, and no live process to probe. Without
// lockAgeSec, that's indistinguishable from "died before ever writing meta"
// and gets reclaimed out from under the still-launching session.
//
// The realistic-heartbeat variant matters: HEARTBEAT is a single global file
// (not scoped to this lock instance) that a prior successful night already
// wrote and nothing ever deletes — heartbeatAgeMin in production is
// realistically always a large STALE number, essentially never `null`
// (ship-check finding: an earlier version of this fix keyed off
// heartbeatAgeMin===null and was unreachable in production because of this).
// metaExists is therefore the only signal that actually distinguishes
// in-flight from pre-meta-dead.
test('decision: fresh lock, no meta.json yet → launch still in flight, NOT reclaimed (realistic stale-heartbeat-from-a-prior-night case)', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0, lockAgeSec: 5, metaExists: false });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /in flight/);
});

test('decision: lock right at the edge of the grace window is still in-flight', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0, lockAgeSec: LAUNCH_INFLIGHT_GRACE_SEC - 1, metaExists: false });
  assert.equal(d.action, 'skip');
});

test('decision: lock past the grace window with no meta.json → genuinely dead, reclaim', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 0, lockAgeSec: LAUNCH_INFLIGHT_GRACE_SEC + 1, metaExists: false });
  assert.equal(d.action, 'reclaim-and-launch');
});

test('decision: unknown lock age (not supplied) falls back to prior stale-path behavior', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 1, metaExists: false });
  assert.equal(d.action, 'reclaim-and-launch');
});

test('decision: metaExists not supplied (unknown caller) defaults to pre-#568 behavior — reclaim, not stuck skipping forever', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 1, lockAgeSec: 5 });
  assert.equal(d.action, 'reclaim-and-launch');
});

test('decision: meta.json exists (attempt died just after writing it) → not treated as in-flight even with a fresh lock', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: 1, lockAgeSec: 5, metaExists: true });
  assert.equal(d.action, 'reclaim-and-launch');
});

// Ordering pin (adversarial-review finding): the in-flight skip must beat
// the attempt-cap escalate, or a slow-but-healthy launch on attempt 3 pages
// the owner mid-launch instead of being left alone.
test('decision: in-flight skip beats attempt-cap escalate — never pages the owner mid-launch', () => {
  const d = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 2880, claudeAlive: false, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT, lockAgeSec: 5, metaExists: false });
  assert.equal(d.action, 'skip');
});

test('decision: attempt cap → escalate, never a 4th Fable session', () => {
  assert.equal(launchDecision({ ...base, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT }).action, 'escalate');
  const dead = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 200, claudeAlive: false, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT });
  assert.equal(dead.action, 'escalate');
});

// ── coverage-complete stop (card #1413) ────────────────────────────────────

test('decision: coverage complete + no live session → stop, before spending another attempt', () => {
  const d = launchDecision({ ...base, coverageComplete: true, attemptsTonight: 0 });
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /coverage complete/);
});

test('decision: coverage complete does NOT default on (every existing caller omits it)', () => {
  assert.equal(launchDecision(base).action, 'launch');
});

test('decision: coverage complete beats the attempt cap — stop, not escalate', () => {
  const d = launchDecision({ ...base, coverageComplete: true, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT });
  assert.equal(d.action, 'stop');
});

test('decision: a LIVE session is never preempted by coverageComplete — the running pass finishes, next tick stops it', () => {
  const d = launchDecision({ ...base, coverageComplete: true, lockExists: true, heartbeatAgeMin: 5, claudeAlive: false });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /heartbeat/);
});

test('decision: a DEAD locked session still reclaims even if coverage looks complete — coverage is only checked once no session is live', () => {
  const d = launchDecision({ ...base, coverageComplete: true, lockExists: true, heartbeatAgeMin: HEARTBEAT_STALE_MIN + 30, claudeAlive: false, attemptsTonight: 0 });
  assert.equal(d.action, 'reclaim-and-launch');
});

// ── shouldPageForFailedPass (card #1413) ───────────────────────────────────

test('shouldPageForFailedPass: a pass killed by the wall clock that still advanced state never pages, even past the attempt cap', () => {
  assert.equal(shouldPageForFailedPass({ consecutiveFailures: MAX_ATTEMPTS_PER_NIGHT, advancedState: true }), false);
  assert.equal(shouldPageForFailedPass({ consecutiveFailures: MAX_ATTEMPTS_PER_NIGHT + 5, advancedState: true }), false);
});

test('shouldPageForFailedPass: a single failure with no progress does not page yet — retries get a chance first', () => {
  assert.equal(shouldPageForFailedPass({ consecutiveFailures: 1, advancedState: false }), false);
});

test('shouldPageForFailedPass: retries exhausted AND no progress → page the owner', () => {
  assert.equal(shouldPageForFailedPass({ consecutiveFailures: MAX_ATTEMPTS_PER_NIGHT, advancedState: false }), true);
});

// ── lock generation token (#569 TOCTOU fix) ────────────────────────────────

function mkLockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'on-monitor-lock-'));
}

test('claimLockGeneration: the claimant is its own owner', () => {
  const dir = mkLockDir();
  const token = claimLockGeneration(dir);
  assert.equal(isLockGenerationOwner(dir, token), true);
});

test('#569 repro: a stale writer holding an old generation token cannot overwrite a newer lock after reclaim', () => {
  const dir = mkLockDir();
  // Tick A launches first and claims generation A — this token is what a
  // slow-but-not-actually-dead launch would still be holding in memory.
  const tokenA = claimLockGeneration(dir);
  assert.equal(isLockGenerationOwner(dir, tokenA), true);

  // A later tick decides (via launchDecision) that A's lock is dead, does
  // its rmSync + mkdirSync reclaim, and claims a fresh generation B — the
  // exact sequence opening-night-monitor-launch.js runs in the
  // reclaim-and-launch branch.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const tokenB = claimLockGeneration(dir);
  assert.notEqual(tokenA, tokenB);

  // Tick A's launchCmuxSession() call finally returns (it wasn't dead, just
  // slow) and it's about to writeFileSync(LOCK_META, ...) using its own
  // stale token — the guard must refuse: A is no longer the owner, B is.
  assert.equal(isLockGenerationOwner(dir, tokenA), false);
  assert.equal(isLockGenerationOwner(dir, tokenB), true);
});

test('isLockGenerationOwner: missing lock dir / generation file reads as not-owner, never throws', () => {
  assert.equal(isLockGenerationOwner('/tmp/does-not-exist-on-monitor-lock-569', 'anything'), false);
  const dir = mkLockDir(); // claimLockGeneration never called — no generation.json yet
  assert.equal(isLockGenerationOwner(dir, 'anything'), false);
});
