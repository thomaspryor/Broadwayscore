import test from 'node:test';
import assert from 'node:assert/strict';
import {
  utcFromZoned, computeWindow, activeWindows, nightKey, launchDecision,
  HEARTBEAT_STALE_MIN, MAX_ATTEMPTS_PER_NIGHT,
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

test('decision: attempt cap → escalate, never a 4th Fable session', () => {
  assert.equal(launchDecision({ ...base, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT }).action, 'escalate');
  const dead = launchDecision({ ...base, lockExists: true, heartbeatAgeMin: 200, claudeAlive: false, attemptsTonight: MAX_ATTEMPTS_PER_NIGHT });
  assert.equal(dead.action, 'escalate');
});
