// scripts/tests/cmux-launch-reclaim.test.mjs
//
// Task #1706 (P1, owner-reproduced 2026-08-16): launchCmuxSession()'s
// late-adoption reclaim (scripts/lib/cmux-launch.js, the lateAdoptSec block)
// is scoped to a SINGLE call. Once its grace window expires with a launch
// still unverified, the function returns `failed` and forgets the workspace
// ever existed — nothing links a later, SEPARATE launchCmuxSession() call for
// the same work back to it. The BRO-343 crown handoff hit this live: two
// launches both reported "LAUNCH NOT VERIFIED (command injection never ran)"
// and were both in fact alive, producing three concurrently-live dispatcher
// sessions on one mandate.
//
// The fix is a cross-invocation launch journal (readLaunchJournalEntry /
// writeLaunchJournalEntry / clearLaunchJournalEntry, all exported from
// cmux-launch.js): a failed launch with a real workspaceRef persists an entry
// keyed by the caller's work identity; the NEXT launchCmuxSession() call for
// that same key checks the entry before creating anything and adopts the
// workspace if it is now confirmed alive.
//
// Per CLAUDE.md rule 15, this requires the REAL exported launchCmuxSession —
// not a reimplementation of the reclaim decision. Its only test seams are the
// existing `probes` mechanism this file already uses to keep waitForLaunchOutcome
// hermetic (wrapperAlive/claudeTagAlive/wake/intervalSec/now), extended here
// with three more of the same kind (strictlyAlive/cmuxExists/newWorkspace) so
// the OS-liveness and cmux-CLI boundaries stay mockable without ever touching
// a real cmux app or process table. cmuxws.listWorkspaces/claudeAliveIn are
// mocked via node:test's `mock.method` on the shared required module object
// (cmux-launch.js accesses them as `cmuxws.X(...)`, a property read on the
// same singleton this test requires — NOT destructured at require-time, which
// is why this technique works here but would not work for `spawnSync`).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const cmuxLaunch = require(path.join(REPO_ROOT, 'scripts/lib/cmux-launch.js'));
const cmuxws = require(path.join(REPO_ROOT, 'scripts/lib/cmux-workspaces.js'));
const {
  launchCmuxSession, readLaunchJournalEntry, writeLaunchJournalEntry, clearLaunchJournalEntry,
} = cmuxLaunch;

function tmpJournalPath() {
  return path.join(os.tmpdir(), `bsc-cmux-launch-journal-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

// Fake clock matching the existing fakeWait() helper's shape in
// cmux-launch.test.mjs — advances 5 simulated seconds per waitForLaunchOutcome
// poll so a real-time grace window costs milliseconds.
function fakeClock() {
  let t = 0;
  return () => { const v = t; t += 5000; return v; };
}

// Base probes shared by every launchCmuxSession call in this file: no real
// wrapper/claude ever registers (so the launch always fails verification),
// nothing sleeps for real, nothing pre-wakes cmux, and the CMUX-CLI-exists
// gate always passes without touching /Applications.
function baseProbes(overrides = {}) {
  return {
    wrapperAlive: () => false,
    claudeTagAlive: () => false,
    wake: () => {}, // no-op: MUST be set or a real `cmux set-app-focus active` fires with no clear
    intervalSec: 0,
    now: fakeClock(),
    idleSec: () => 0, // < IDLE_GATE_SEC so the idle-gated pre-wake never fires either
    cmuxExists: () => true,
    // Card #1829: MUST be stubbed, same reason as cmuxExists/wake above — the
    // default falls back to cmux-launch.js's defaultSurfaceAliveFn (built on
    // cmuxws.terminalSurfaceConfirmedMissing), which shells out to the real
    // cmux CLI. Defaulting to "alive" here keeps every
    // pre-#1829 test in this file exercising exactly the wrapper/tag failure
    // path it was written for, not a real (and here undefined-behavior)
    // read-screen call against a fabricated workspace ref.
    terminalSurfaceAlive: () => true,
    // Task #1904: MUST be stubbed for the same reason as cmuxExists/wake/
    // terminalSurfaceAlive above — the default shells out to the real
    // `cmux debug-terminals` and consults this MACHINE's learned ceiling, so
    // once a real dispatch here has hit the cap, every launch in this file
    // would be refused at the preflight and these tests would fail for a
    // reason that has nothing to do with what they assert. "Capacity
    // available, ceiling unknown" is the neutral answer that keeps each test
    // exercising exactly the path it was written for.
    terminalCapacity: () => ({ hasCapacity: true, known: false, liveRuntimes: null, ceiling: null, reason: 'stubbed', surfaces: null }),
    // Nothing in this file should teach the real machine's ceiling file.
    recordCapacityOutcome: () => ({ ceiling: null, changed: false, reason: 'stubbed' }),
    ...overrides,
  };
}

test('launchCmuxSession: a failed launch with a real workspaceRef journals an entry keyed by workKey', () => {
  const journalPath = tmpJournalPath();
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9001\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    const res = launchCmuxSession({
      title: 'test launch', seed: 'seed text', seedKey: 'reclaim-1706-a', workKey: 'task-1706',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock },
    });

    assert.equal(res.ok, false, 'no wrapper/claude ever registers — this launch must report unverified');
    assert.equal(res.workspaceRef, 'workspace:9001');
    assert.equal(newWorkspaceMock.mock.callCount(), 1);

    const entry = readLaunchJournalEntry('task-1706', journalPath);
    assert.ok(entry, 'a failed launch with a real workspaceRef must be journaled');
    assert.equal(entry.workspaceRef, 'workspace:9001');
    assert.ok(entry.marker, 'the journal entry must carry this launch\'s exact cmdMarker for the OS-liveness cross-check');
  } finally {
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('launchCmuxSession: two sequential calls for the same work — the second ADOPTS the first instead of launching a second session', () => {
  const journalPath = tmpJournalPath();
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9002\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    // Call 1: reports unverified (INJECTION_NEVER_RAN) and journals workspace:9002.
    const first = launchCmuxSession({
      title: 'test launch', seed: 'seed text', seedKey: 'reclaim-1706-b', workKey: 'task-1706-dup',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock },
    });
    assert.equal(first.ok, false);
    assert.equal(first.workspaceRef, 'workspace:9002');
    assert.equal(newWorkspaceMock.mock.callCount(), 1);

    // Between calls, the "orphan" comes alive — the exact case this card
    // reproduced live (a launch reported unverified, and was in fact running).
    // seedKey deliberately DIFFERS from call 1 — proves reclaim keys on
    // workKey, not seedKey, so a caller whose seedKey varies between attempts
    // (the card's cited example: an ad-hoc handoff dispatch outside this
    // repo) can still opt in by passing a stable workKey.
    const second = launchCmuxSession({
      title: 'test launch retry', seed: 'seed text', seedKey: 'reclaim-1706-b-retry', workKey: 'task-1706-dup',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, strictlyAlive: () => true },
    });

    assert.equal(second.ok, true, 'a confirmed-alive prior launch must be adopted, not reported as a new failure');
    assert.equal(second.ref, 'workspace:9002', 'must adopt the SAME workspace call 1 created');
    assert.equal(second.adoptedLate, true);
    assert.equal(second.reclaimedAcrossInvocation, true);
    assert.equal(newWorkspaceMock.mock.callCount(), 1, 'the second call must NOT create a second real workspace — this is the whole bug');

    // Adoption must clear the entry — a THIRD call must not still find it
    // there pointing at a workspace it never re-verified for.
    assert.equal(readLaunchJournalEntry('task-1706-dup', journalPath), null);
  } finally {
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('launchCmuxSession: force does NOT bypass reclaim when the prior workspace is confirmed alive', () => {
  const journalPath = tmpJournalPath();
  writeLaunchJournalEntry('task-1706-force', {
    workspaceRef: 'workspace:9003', marker: 'bsc-cmd-task-1706-force-deadbeef.sh',
    state: 'injection-never-ran', timestamp: new Date(0).toISOString(),
  }, journalPath);
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9099\n', stderr: '' }));

  try {
    const res = launchCmuxSession({
      title: 'test launch force', seed: 'seed text', seedKey: 'reclaim-1706-c', workKey: 'task-1706-force',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true, force: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, strictlyAlive: () => true },
    });

    assert.equal(res.ok, true);
    assert.equal(res.ref, 'workspace:9003', '--force must not skip the liveness check and launch workspace:9099 anyway');
    assert.equal(res.reclaimedAcrossInvocation, true);
    assert.equal(newWorkspaceMock.mock.callCount(), 0, 'force must never cause a second real workspace to be created over a confirmed-alive one');
  } finally {
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('launchCmuxSession: a journaled entry that is now confirmed DEAD is dropped, not reused, and a fresh launch proceeds', () => {
  const journalPath = tmpJournalPath();
  writeLaunchJournalEntry('task-1706-dead', {
    workspaceRef: 'workspace:9004', marker: 'bsc-cmd-task-1706-dead-deadbeef.sh',
    state: 'injection-never-ran', timestamp: new Date(0).toISOString(),
  }, journalPath);
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9005\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    const res = launchCmuxSession({
      title: 'test launch dead orphan', seed: 'seed text', seedKey: 'reclaim-1706-d', workKey: 'task-1706-dead',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, strictlyAlive: () => false },
    });

    assert.equal(newWorkspaceMock.mock.callCount(), 1, 'a confirmed-dead journal entry must not block a fresh launch attempt');
    assert.equal(res.workspaceRef, 'workspace:9005', 'the fresh attempt gets its own workspace, not the dead one');
    // The dead entry is replaced by this call's own (also-failed) journal write.
    const entry = readLaunchJournalEntry('task-1706-dead', journalPath);
    assert.equal(entry.workspaceRef, 'workspace:9005');
  } finally {
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('readLaunchJournalEntry/writeLaunchJournalEntry/clearLaunchJournalEntry: real file round-trip', () => {
  const journalPath = tmpJournalPath();
  try {
    assert.equal(readLaunchJournalEntry('k1', journalPath), null, 'missing journal reads as no entry, not an error');
    writeLaunchJournalEntry('k1', { workspaceRef: 'workspace:1', marker: 'm1' }, journalPath);
    writeLaunchJournalEntry('k2', { workspaceRef: 'workspace:2', marker: 'm2' }, journalPath);
    assert.deepEqual(readLaunchJournalEntry('k1', journalPath), { workspaceRef: 'workspace:1', marker: 'm1' });
    assert.deepEqual(readLaunchJournalEntry('k2', journalPath), { workspaceRef: 'workspace:2', marker: 'm2' });
    clearLaunchJournalEntry('k1', journalPath);
    assert.equal(readLaunchJournalEntry('k1', journalPath), null, 'clearing k1 must not disturb k2');
    assert.deepEqual(readLaunchJournalEntry('k2', journalPath), { workspaceRef: 'workspace:2', marker: 'm2' });
  } finally {
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('writeLaunchJournalEntry: writes via atomic rename — no stray .tmp file survives, and the final file is valid JSON', () => {
  const journalPath = tmpJournalPath();
  try {
    writeLaunchJournalEntry('k1', { workspaceRef: 'workspace:1', marker: 'm1' }, journalPath);
    const dir = path.dirname(journalPath);
    const base = path.basename(journalPath);
    const strays = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.`) && f.endsWith('.tmp'));
    assert.deepEqual(strays, [], 'the temp file used for the atomic rename must not be left behind');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(journalPath, 'utf8')));
  } finally {
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('CMUX_LAUNCH_RECLAIM_DISABLED=1: kill switch reverts to pre-#1706 behavior — no read, no write, no adoption', () => {
  const journalPath = tmpJournalPath();
  const prev = process.env.CMUX_LAUNCH_RECLAIM_DISABLED;
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9100\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    // Seed an entry directly (bypassing the disabled write path) so a real
    // reclaim WOULD fire if the kill switch weren't respected.
    process.env.CMUX_LAUNCH_RECLAIM_DISABLED = ''; // temporarily enabled to seed
    writeLaunchJournalEntry('task-1706-killswitch', {
      workspaceRef: 'workspace:9099', marker: 'bsc-cmd-task-1706-killswitch-deadbeef.sh',
      state: 'injection-never-ran', timestamp: new Date(0).toISOString(),
    }, journalPath);

    process.env.CMUX_LAUNCH_RECLAIM_DISABLED = '1';
    const res = launchCmuxSession({
      title: 'test launch killswitch', seed: 'seed text', seedKey: 'reclaim-1706-e', workKey: 'task-1706-killswitch',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, strictlyAlive: () => true },
    });

    assert.equal(newWorkspaceMock.mock.callCount(), 1, 'disabled reclaim must fall through to a normal launch attempt, ignoring the seeded entry');
    assert.equal(res.workspaceRef, 'workspace:9100', 'must get a fresh workspace, not adopt the seeded one');
    assert.notEqual(res.reclaimedAcrossInvocation, true);

    // The pre-seeded entry must survive untouched — disabled means no writes either.
    process.env.CMUX_LAUNCH_RECLAIM_DISABLED = '';
    const entry = readLaunchJournalEntry('task-1706-killswitch', journalPath);
    assert.equal(entry.workspaceRef, 'workspace:9099', 'a disabled kill switch must not overwrite the journal either');
  } finally {
    if (prev === undefined) delete process.env.CMUX_LAUNCH_RECLAIM_DISABLED;
    else process.env.CMUX_LAUNCH_RECLAIM_DISABLED = prev;
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

// ── Card #1829: a confirmed-missing terminal surface is no longer adoptable ─
// The incident: 7/7 cmux-tab dispatches on 2026-08-19 created a workspace
// with a live cmux tag AND a live OS wrapper process, but the terminal
// surface never rendered (`cmux read-screen` returned "Terminal surface not
// found" on all seven, one 50 minutes old). strictlyAliveWorkspace previously
// only checked the tag + OS-process signals, so BOTH the in-call late-adopt
// watch and the cross-invocation reclaim journal (this file's whole subject)
// reported these workspaces alive and the launcher returned ok:true with
// nothing actually running. These tests exercise the REAL launchCmuxSession
// end to end (rule 15) with terminalSurfaceAlive as the one signal under test.
test('launchCmuxSession: a journaled entry whose OS/tag signals look alive but read-screen confirms no surface is NOT reclaimed — reported failed instead', () => {
  const journalPath = tmpJournalPath();
  writeLaunchJournalEntry('task-1829-surface', {
    workspaceRef: 'workspace:9400', marker: 'bsc-cmd-task-1829-surface-deadbeef.sh',
    state: 'injection-never-ran', timestamp: new Date(0).toISOString(),
  }, journalPath);
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9401\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => [{ ref: 'workspace:9400', title: 'stale' }]);
  const claudeAliveMock = mock.method(cmuxws, 'claudeAliveIn', () => true);

  try {
    const res = launchCmuxSession({
      title: 'test launch surface-dead reclaim', seed: 'seed text', seedKey: 'reclaim-1829-a', workKey: 'task-1829-surface',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      // terminalSurfaceAlive: false reproduces the exact 2026-08-19 shape —
      // cmux's own tag registry mocked alive above (that registry really did
      // report these workspaces as having a live claude), and the OS-process
      // signal is left unstubbed here (osProcessAliveForSeed reads the real
      // `ps` table for this never-real marker and legitimately finds
      // nothing, same as incident evidence #3 — no matching process existed
      // by the time anything checked). Only read-screen is authoritative for
      // "this exact scenario is what strictlyAliveWorkspace must now refuse",
      // and it's the one signal isolated as the deciding AND-term by
      // computeStrictAliveness's direct unit tests in cmux-launch.test.mjs.
      probes: { ...baseProbes(), terminalSurfaceAlive: () => false, newWorkspace: newWorkspaceMock },
    });

    assert.equal(res.ok, false, 'a confirmed-missing surface must never be reported as a successful launch');
    assert.notEqual(res.reclaimedAcrossInvocation, true, 'the journaled entry must not be reclaimed');
    assert.equal(newWorkspaceMock.mock.callCount(), 1, 'refusing to reclaim still lets a fresh launch attempt proceed');
  } finally {
    listMock.mock.restore();
    claudeAliveMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

// Second-opinion review of this card's first pass flagged that the fix above
// only covered the late-adopt/reclaim paths — the FAST path (wrapper + tag
// both register within the first few polls, `outcome.action === 'ok'` on
// attempt 1, no late-adopt or reclaim ever consulted) is what most real
// dispatches actually take, and it had the identical #548-class blind spot:
// claudeRegistered trusts wrapperAlive+tagAlive alone. This test drives that
// exact path — instant wrapper+tag registration — with the surface signal
// confirmed dead, and proves the launcher refuses to report success there too.
test('launchCmuxSession: instant wrapper+tag registration (the common-case fast path) still refuses success when read-screen confirms no surface', () => {
  const journalPath = tmpJournalPath();
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9500\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    const res = launchCmuxSession({
      title: 'test launch fast-path surface-dead', seed: 'seed text', seedKey: 'reclaim-1829-b', workKey: 'task-1829-fastpath',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: {
        ...baseProbes(),
        wrapperAlive: () => true, // registers on the very first poll — the common case
        claudeTagAlive: () => true,
        terminalSurfaceAlive: () => false, // …but the surface never rendered (#548-class desync)
        newWorkspace: newWorkspaceMock,
      },
    });

    assert.equal(res.ok, false, 'wrapper+tag alone must never be enough to report success once read-screen disagrees');
    assert.match(res.reason || '', /surface/i, 'the failure reason must name the surface check, not a generic verify failure');
    assert.equal(res.deadConfirmed, true, 'a confirmed-missing surface is a real death, not an ambiguous/slow-boot case');
  } finally {
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('launchCmuxSession: instant wrapper+tag registration WITH a real surface still succeeds (no false failures from the new check)', () => {
  const journalPath = tmpJournalPath();
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9501\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);

  try {
    const res = launchCmuxSession({
      title: 'test launch fast-path healthy', seed: 'seed text', seedKey: 'reclaim-1829-c', workKey: 'task-1829-fastpath-ok',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath,
      probes: {
        ...baseProbes(), // terminalSurfaceAlive: () => true by default
        wrapperAlive: () => true,
        claudeTagAlive: () => true,
        newWorkspace: newWorkspaceMock,
      },
    });

    assert.equal(res.ok, true, 'a genuinely healthy fast-path launch must not be penalized by the new surface check');
    assert.equal(res.ref, 'workspace:9501');
    assert.equal(newWorkspaceMock.mock.callCount(), 1);
  } finally {
    listMock.mock.restore();
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

test('readLaunchJournalEntry: a corrupt/non-object journal file reads as no entries, never throws', () => {
  const journalPath = tmpJournalPath();
  try {
    fs.writeFileSync(journalPath, 'not json{{{');
    assert.doesNotThrow(() => readLaunchJournalEntry('anything', journalPath));
    assert.equal(readLaunchJournalEntry('anything', journalPath), null);

    fs.writeFileSync(journalPath, '[1,2,3]'); // valid JSON, wrong shape (array not object)
    assert.equal(readLaunchJournalEntry('anything', journalPath), null);
  } finally {
    try { fs.unlinkSync(journalPath); } catch { /* cleanup */ }
  }
});

// ── Task #1904: the terminal-runtime capacity preflight ────────────────────
// Past cmux's ceiling, `new-workspace` still succeeds and still accepts
// --command; it just never attaches a terminal, so the command can never run.
// The only correct move is to not create the workspace at all.

const AT_CAPACITY = {
  hasCapacity: false, known: true, liveRuntimes: 29, ceiling: 29,
  reason: 'cmux is at its terminal-runtime ceiling: 29 live terminal(s), cap observed at 29. Close finished tabs (bsc-prune) or restart cmux to free a runtime.',
  surfaces: null,
};

test('launchCmuxSession: at the terminal-runtime ceiling it creates NOTHING and says why', () => {
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9100\n', stderr: '' }));
  const res = launchCmuxSession({
    title: 'capacity refusal', seed: 'seed text', seedKey: 'capacity-1904-a',
    cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
    verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath: tmpJournalPath(),
    probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, terminalCapacity: () => AT_CAPACITY },
  });

  assert.equal(res.ok, false);
  assert.equal(res.refusedForCapacity, true);
  assert.equal(res.terminalRuntimeMissing, undefined,
    'refusedForCapacity and terminalRuntimeMissing must stay distinct — only the first means "nothing was created"');
  assert.equal(newWorkspaceMock.mock.callCount(), 0,
    'creating a workspace that can never run its command is the whole waste this gate removes');
  assert.equal(res.workspaceRef, null,
    'no workspace means failedLaunchEntries() writes nothing — no phantom dead row, no burned dispatch attempt');
  assert.match(res.reason, /ceiling/i);
  assert.match(res.reason, /bsc-prune|restart cmux/, 'the refusal must name what actually frees a runtime');
});

test('launchCmuxSession: --force overrides the capacity gate, because the ceiling is a LEARNED number', () => {
  // A learned number has to stay disprovable: if cmux ships a higher cap, the
  // only evidence that can raise the ceiling is a launch that succeeds above
  // it, and the gate is what would otherwise prevent that launch forever.
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9101\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);
  try {
    const res = launchCmuxSession({
      title: 'forced past capacity', seed: 'seed text', seedKey: 'capacity-1904-b', force: true,
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath: tmpJournalPath(),
      probes: { ...baseProbes(), newWorkspace: newWorkspaceMock, terminalCapacity: () => AT_CAPACITY },
    });
    assert.equal(newWorkspaceMock.mock.callCount() > 0, true, 'force must reach cmux');
    assert.equal(res.refusedForCapacity, undefined, 'a forced launch is judged on what it actually did, not on the estimate');
  } finally { listMock.mock.restore(); }
});

test('launchCmuxSession: an UNKNOWN capacity reading never blocks a launch', () => {
  // debug-terminals is an undocumented command. If it vanishes or changes
  // shape, dispatch must behave exactly as it does today.
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9102\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);
  try {
    launchCmuxSession({
      title: 'unknown capacity', seed: 'seed text', seedKey: 'capacity-1904-c',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath: tmpJournalPath(),
      probes: {
        ...baseProbes(),
        newWorkspace: newWorkspaceMock,
        terminalCapacity: () => ({ hasCapacity: true, known: false, liveRuntimes: null, ceiling: null, reason: 'unknown', surfaces: null }),
      },
    });
    assert.equal(newWorkspaceMock.mock.callCount() > 0, true);
  } finally { listMock.mock.restore(); }
});

test('launchCmuxSession: a workspace with no terminal is dead-confirmed, attributable, and teaches the ceiling', () => {
  // The bootstrap path: no ceiling is known yet, so the launch goes ahead, the
  // surface is confirmed missing, and the grace expires with nothing ever
  // running. That verdict must (a) be a confirmed death, (b) keep its
  // workspaceRef so the corpse stays attributable, and (c) record the
  // live-runtime count as a ceiling OBSERVATION — which is what eventually
  // arms the pre-create gate, once a second observation confirms it.
  //
  // It does not relaunch, but that is this function's standing owner-approved
  // no-relaunch rule (2026-08-13, the 'retry' branch's break), NOT something
  // the capacity work introduced — the state machine returns the same attempt
  // budget INJECTION_NEVER_RAN always had.
  const newWorkspaceMock = mock.fn(() => ({ status: 0, stdout: 'OK workspace:9103\n', stderr: '' }));
  const listMock = mock.method(cmuxws, 'listWorkspaces', () => []);
  const learned = [];
  try {
    const res = launchCmuxSession({
      title: 'no terminal attached', seed: 'seed text', seedKey: 'capacity-1904-d',
      cwd: REPO_ROOT, model: 'sonnet', focus: false, skipAuthPreflight: true,
      verifyTimeoutSec: 1, lateAdoptSec: 0, journalPath: tmpJournalPath(),
      probes: {
        ...baseProbes(),
        newWorkspace: newWorkspaceMock,
        terminalCapacity: () => ({ hasCapacity: true, known: true, liveRuntimes: 29, ceiling: null, reason: 'no ceiling yet', surfaces: null }),
        surfaceConfirmedMissing: () => true,
        atTerminalCapacity: () => false, // nothing learned yet — this is the FIRST hit
        terminalSurfaceAlive: () => false,
        recordCapacityOutcome: (o) => { learned.push(o); return { ceiling: o.liveRuntimesBefore, changed: true, reason: 'learned' }; },
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, 'terminal-runtime-missing');
    assert.equal(res.deadConfirmed, true, 'a workspace with no terminal is a corpse, not a slow boot');
    assert.equal(res.terminalRuntimeMissing, true);
    assert.equal(res.refusedForCapacity, undefined,
      'a workspace WAS created here — reporting this as a refusal would log "nothing was created" over a real ghost tab and journal it with a null ref, losing its attribution entirely');
    assert.equal(res.workspaceRef, 'workspace:9103', 'the corpse must stay attributable');
    assert.equal(newWorkspaceMock.mock.callCount(), 1, 'exactly one workspace, never a relaunch over a possibly-live tab');
    assert.deepEqual(learned, [{ liveRuntimesBefore: 29, outcome: 'runtime-missing' }],
      'the first launch to hit the cap is what arms the preflight for every later dispatch');
  } finally { listMock.mock.restore(); }
});
