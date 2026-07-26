import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs, failedLaunchEntries, DEAD_ATTEMPT_LIMIT } = require('./dispatch-ledger.js');
const { shouldAdoptLateStart } = require('./cmux-launch.js');

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ledger-test-')), 'ledger.jsonl');
}

test('appendEntry requires event + taskId, stamps ts, round-trips via readEntries', () => {
  const p = tmpLedger();
  assert.throws(() => appendEntry({ taskId: '1' }, p), /event/);
  assert.throws(() => appendEntry({ event: 'launch' }, p), /taskId/);
  const written = appendEntry({ event: 'launch', taskId: '297', workspaceRef: 'workspace:227' }, p);
  assert.ok(written.ts);
  const entries = readEntries(p);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, '297');
});

test('readEntries: missing file returns [], corrupt lines are skipped not fatal', () => {
  assert.deepEqual(readEntries('/nonexistent/path/ledger.jsonl'), []);
  const p = tmpLedger();
  fs.writeFileSync(p, '{"event":"launch","taskId":"1"}\nnot json\n{"event":"dead","taskId":"1","workspaceRef":"workspace:1"}\n');
  const entries = readEntries(p);
  assert.equal(entries.length, 2);
});

test('deadAttemptsForTask filters by taskId and event=dead, ignores launches', () => {
  const entries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:229' },
    { event: 'dead', taskId: '46', workspaceRef: 'workspace:5' },
  ];
  assert.equal(deadAttemptsForTask('297', entries).length, 2);
  assert.equal(deadAttemptsForTask(297, entries).length, 2); // numeric/string id agnostic
  assert.equal(deadAttemptsForTask('46', entries).length, 1);
  assert.equal(deadAttemptsForTask('999', entries).length, 0);
});

test('launchByRef finds the launch entry that produced a given workspace ref', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '29', subject: 'Rage clicks', workspaceRef: 'workspace:231' },
  ];
  assert.equal(launchByRef('workspace:227', entries).taskId, '297');
  assert.equal(launchByRef('workspace:404', entries), null);
});

test('DEAD_ATTEMPT_LIMIT is 2 — matches the real incident (2 dead shells existed before the 3rd)', () => {
  assert.equal(DEAD_ATTEMPT_LIMIT, 2);
});

test('deadBreadcrumbs: only idle workspaces with a matching launch record produce breadcrumbs', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
  ];
  const idle = [
    { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' },       // dead auto-dispatch — should breadcrumb
    { ref: 'workspace:900', title: 'Some manually opened tab' },    // never launched by bsc-next — skip
  ];
  const bc = deadBreadcrumbs(idle, entries);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].event, 'dead');
  assert.equal(bc[0].taskId, '297');
  assert.equal(bc[0].workspaceRef, 'workspace:227');
});

test('deadBreadcrumbs is idempotent — a workspace already marked dead does not re-breadcrumb', () => {
  const entries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
  ];
  const idle = [{ ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }];
  assert.deepEqual(deadBreadcrumbs(idle, entries), []);
});

test('deadBreadcrumbs across repeated sweeps: second sweep sees the first sweep\'s writes and stops re-flagging', () => {
  const entries = [{ event: 'launch', taskId: '297', workspaceRef: 'workspace:227' }];
  const idle = [{ ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }];
  const firstSweep = deadBreadcrumbs(idle, entries);
  assert.equal(firstSweep.length, 1);
  const afterWrite = [...entries, ...firstSweep];
  const secondSweep = deadBreadcrumbs(idle, afterWrite);
  assert.equal(secondSweep.length, 0);
});

// ── Task #503: the guard above shipped armed and STILL let 10 orphan auto-
// shells and 4 duplicate dispatches accumulate on 2026-07-26. The chain:
//   bsc-next's 30s verify window expired before claude registered a process
//   → launchCmuxSession returned ok:false with the workspace still open
//   → bsc-next's failure branch wrote NOTHING to the ledger
//   → deadBreadcrumbs() skipped the orphan ("no launch record — not ours")
//   → deadAttemptsForTask() saw 0 deaths, so nothing ever refused re-dispatch
// Every test above operates on entries that only exist if the failure branch
// writes them. These pin that it does — and that a merely-slow claude is
// adopted rather than counted as a death at all.

test('failedLaunchEntries journals a launch AND a dead entry for the orphan shell', () => {
  const entries = failedLaunchEntries({
    taskId: 466, subject: 'push-with-retry.sh refspec fetch', workspaceRef: 'workspace:46',
    model: 'sonnet', verifyCmd: 'node --test x.test.mjs', verifyReason: null,
    notionId: 'abc', failureReason: 'no running claude in workspace:46 after 2 attempts',
  });
  // 'dead' FIRST — see the interleaving test below for why the order is load-bearing.
  assert.deepEqual(entries.map(e => e.event), ['dead', 'launch']);
  // taskId stringified so the ledger stays homogeneous with every other writer.
  assert.equal(entries[0].taskId, '466');
  assert.equal(entries[0].workspaceRef, 'workspace:46');
  assert.equal(entries[1].unverified, true);
  assert.equal(entries[1].failureReason, 'no running claude in workspace:46 after 2 attempts');
});

test('a bsc-prune sweep interleaving between the two writes cannot double-count the failure', () => {
  // The pair is two separate appendFileSync calls, so a sweep CAN land between
  // them. With 'launch' written first, that sweep would see a launch with no
  // recorded death, emit its own 'dead', and one failed dispatch would count as
  // two — tripping the 2-death guard off a single bad launch.
  const [first, second] = failedLaunchEntries({
    taskId: 466, subject: 's', workspaceRef: 'workspace:46', failureReason: 'r',
  });
  const idle = [{ ref: 'workspace:46', title: '🤖⚡ Infra·s' }];

  // Sweep lands after write #1 only: no launch record yet, so nothing to journal.
  assert.deepEqual(deadBreadcrumbs(idle, [first]), []);
  // Sweep lands after both writes: the death is already recorded, so it skips.
  assert.deepEqual(deadBreadcrumbs(idle, [first, second]), []);
  // Either way the task ends up with exactly ONE death, not two.
  assert.equal(deadAttemptsForTask(466, [first, second]).length, 1);
});

test('failedLaunchEntries writes nothing when cmux left no workspace to attribute', () => {
  assert.deepEqual(failedLaunchEntries({
    taskId: 466, subject: 's', workspaceRef: null, failureReason: 'cmux exited 1',
  }), []);
});

test('two failed launches arm the dead-dispatch guard (previously: zero recorded deaths)', () => {
  const mk = ref => failedLaunchEntries({ taskId: 466, subject: 's', workspaceRef: ref, failureReason: 'r' });
  const entries = [...mk('workspace:46'), ...mk('workspace:47')];
  assert.equal(deadAttemptsForTask(466, entries).length, DEAD_ATTEMPT_LIMIT);
  assert.equal(deadAttemptsForTask(466, []).length, 0); // the pre-fix state
});

test('a failed launch makes its orphan shell attributable to the task in a later sweep', () => {
  const entries = failedLaunchEntries({
    taskId: 486, subject: 'update-show-status dedup', workspaceRef: 'workspace:65', failureReason: 'r',
  });
  const launch = launchByRef('workspace:65', entries);
  assert.equal(launch && launch.taskId, '486');
  assert.equal(launch.subject, 'update-show-status dedup');
});

test('a journaled failed launch does not double-count when bsc-prune later sweeps the same shell', () => {
  const entries = failedLaunchEntries({
    taskId: 497, subject: 'digest fold', workspaceRef: 'workspace:81', failureReason: 'r',
  });
  const idle = [{ ref: 'workspace:81', title: '🤖⚡ Loop·digest fold' }];
  // One failure must equal one death — otherwise a single slow launch would
  // trip the 2-death guard on its own.
  assert.deepEqual(deadBreadcrumbs(idle, entries), []);
});

test('a claude that registers after the verify window is adopted, not declared dead', () => {
  const failed = { ok: false, workspaceRef: 'workspace:46', reason: 'no running claude after 2 attempts' };
  assert.equal(shouldAdoptLateStart(failed, true), true);
  assert.equal(shouldAdoptLateStart(failed, false), false);
  assert.equal(shouldAdoptLateStart({ ok: false, workspaceRef: null }, true), false); // nothing to adopt
  assert.equal(shouldAdoptLateStart({ ok: true, ref: 'workspace:46' }, true), false); // already verified
});

test('a failed launch never attributes attempt 1\'s closed workspace to attempt 2', () => {
  const raw = fs.readFileSync(new URL('./cmux-launch.js', import.meta.url), 'utf8');
  // Strip comments before asserting — the fix's own comment quotes the removed
  // pattern to explain it, and a naive whole-file scan would match that.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // `lastWs = ws || lastWs` carried attempt 1's ref forward, so if attempt 2
  // could not resolve its own ref, the late-adopt watch and the caller's
  // failure journaling both pointed at a workspace this function had already
  // CLOSED — while attempt 2's real workspace stayed unattributed. Attribution
  // is the entire point of the fix, so the carry-forward must stay gone.
  assert.doesNotMatch(src, /lastWs\s*=\s*ws\s*\|\|\s*lastWs/);
  assert.match(src, /survivingWs\s*=\s*ws\s*\|\|\s*null/);
  // And the ref must be dropped the moment attempt 1's workspace is closed.
  assert.match(src, /closeWorkspace\(ws\.ref\)[\s\S]{0,200}survivingWs\s*=\s*null/);
});

test('bsc-next dispatches with the long verify window + late-adopt grace, and journals failures', () => {
  const src = fs.readFileSync(new URL('../bsc-next.js', import.meta.url), 'utf8');
  // The 30s default is what produced the false failures; bsc-next must pass the
  // same window the opening-night launcher has used since its own 2026-07-24
  // false CRITICAL, and must ask for late adoption.
  assert.match(src, /verifyTimeoutSec:\s*90,\s*lateAdoptSec:\s*60/);
  assert.match(src, /failedLaunchEntries/);
});
