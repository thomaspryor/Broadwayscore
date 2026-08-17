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
