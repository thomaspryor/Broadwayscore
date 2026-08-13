import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs, failedLaunchEntries, DEAD_ATTEMPT_LIMIT, detectLauncherOutage, successionDepthForTask, SUCCESSION_DEPTH_CAP, classifyDeadAttemptsForTask, substantiveDeadAttemptsForTask, dispatchCapDecision } = require('./dispatch-ledger.js');
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

test('successionDepthForTask: no launches yet is depth 0, a fresh (non-succession) launch is depth 1', () => {
  assert.equal(successionDepthForTask('856', []), 0);
  const entries = [{ event: 'launch', taskId: '856', ts: '2026-08-03T00:00:00Z', workspaceRef: 'workspace:1' }];
  assert.equal(successionDepthForTask('856', entries), 1);
});

test('successionDepthForTask: each successionOf launch increments the chain', () => {
  const entries = [
    { event: 'launch', taskId: '856', ts: '2026-08-03T00:00:00Z', workspaceRef: 'workspace:1' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T01:00:00Z', workspaceRef: 'workspace:2', successionOf: 'workspace:1' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T02:00:00Z', workspaceRef: 'workspace:3', successionOf: 'workspace:2' },
  ];
  assert.equal(successionDepthForTask('856', entries), 3);
});

test('successionDepthForTask: a fresh (non-succession) redispatch resets the chain', () => {
  const entries = [
    { event: 'launch', taskId: '856', ts: '2026-08-03T00:00:00Z', workspaceRef: 'workspace:1' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T01:00:00Z', workspaceRef: 'workspace:2', successionOf: 'workspace:1' },
    // owner --force redispatches from scratch after investigating — new chain starts at 1
    { event: 'launch', taskId: '856', ts: '2026-08-03T05:00:00Z', workspaceRef: 'workspace:9' },
  ];
  assert.equal(successionDepthForTask('856', entries), 1);
});

test('successionDepthForTask ignores other tasks and unordered ts input', () => {
  const entries = [
    { event: 'launch', taskId: '9', ts: '2026-08-03T09:00:00Z', workspaceRef: 'workspace:9', successionOf: 'x' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T02:00:00Z', workspaceRef: 'workspace:3', successionOf: 'workspace:2' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T00:00:00Z', workspaceRef: 'workspace:1' },
    { event: 'launch', taskId: '856', ts: '2026-08-03T01:00:00Z', workspaceRef: 'workspace:2', successionOf: 'workspace:1' },
  ];
  assert.equal(successionDepthForTask('856', entries), 3);
});

test('SUCCESSION_DEPTH_CAP is 5', () => {
  assert.equal(SUCCESSION_DEPTH_CAP, 5);
});

test('launchByRef finds the launch entry that produced a given workspace ref', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '29', subject: 'Rage clicks', workspaceRef: 'workspace:231' },
  ];
  assert.equal(launchByRef('workspace:227', entries).taskId, '297');
  assert.equal(launchByRef('workspace:404', entries), null);
});

test('launchByRef is LAST-match, not first — a recycled ref attributes to the CURRENT task (card #960)', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:12', ts: '2026-07-01T00:00:00Z' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:12', ts: '2026-07-01T01:00:00Z' },
    // cmux restarted and re-issued workspace:12 to an unrelated later task.
    { event: 'launch', taskId: '640', subject: 'Rage clicks sweep', workspaceRef: 'workspace:12', ts: '2026-08-03T00:00:00Z' },
  ];
  const launch = launchByRef('workspace:12', entries);
  assert.equal(launch.taskId, '640');
  assert.equal(launch.subject, 'Rage clicks sweep');
});

test('DEAD_ATTEMPT_LIMIT is 2 — matches the real incident (2 dead shells existed before the 3rd)', () => {
  assert.equal(DEAD_ATTEMPT_LIMIT, 2);
});

// Regression guard for the 2026-08-11 P0: module.exports named two functions a
// competing implementation of card #1233 had deleted, so require() threw
// ReferenceError and backlog-drain, bsc-runner, bsc-next, dispatch-watchdog and
// the S6 canary all died on load. A name that survives the ReferenceError but
// resolves to undefined (declared-later var, renamed helper) fails the same way
// at the call site, silently — assert every export actually carries a value.
test('every module.exports name resolves to a defined value (no stale/renamed exports)', () => {
  const mod = require('./dispatch-ledger.js');
  const undefinedExports = Object.keys(mod).filter((k) => mod[k] === undefined);
  assert.deepEqual(undefinedExports, [], `exported but undefined: ${undefinedExports.join(', ')}`);
});

// Card #1233's infra-vs-substantive coverage now lives with the v2 API at the
// bottom of this file (classifyDeadAttemptsForTask + dispatchCapDecision).
// The four tests that stood here called the v1 API (isInfraDeadEntry /
// deadDispatchCapStatus), which commit ba2a4f22d3f deleted — two racing
// sessions on the same card left them behind, and they threw ReferenceError
// on every run. Do not restore them from an old branch during a merge.
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

test('deadBreadcrumbs attributes a recycled ref to the CURRENT task, not the long-dead one (card #960)', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'old task, long gone', workspaceRef: 'workspace:12', ts: '2026-07-01T00:00:00Z' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:12', ts: '2026-07-01T01:00:00Z' },
    // cmux recycled workspace:12 onto a fresh, healthy task's dispatch.
    { event: 'launch', taskId: '640', subject: 'current healthy task', workspaceRef: 'workspace:12', ts: '2026-08-03T00:00:00Z' },
  ];
  const idle = [{ ref: 'workspace:12', title: 'current healthy task' }];
  const bc = deadBreadcrumbs(idle, entries);
  assert.equal(bc.length, 1);
  // Before the fix (first-match + ref-only idempotency), this would poison
  // task 297's count a second time and never touch 640 — the healthy task's
  // death would stay hidden forever, since the OLD 'dead' entry for this ref
  // would look like it already covers the new launch too.
  assert.equal(bc[0].taskId, '640');
  assert.equal(bc[0].subject, 'current healthy task');
});

test('deadBreadcrumbs: a dead entry stamped at the SAME instant as the current launch still suppresses (fail-safe direction)', () => {
  // Real appendEntry() writes are monotonically increasing ISO timestamps
  // from separate lifecycle events, so an exact tie is a contrived edge —
  // but the >= comparison must resolve it toward "don't re-flag" (matching
  // every other ts-reconciled function in this file: vanishedBreadcrumbs,
  // pruneClosedEntry, findLedgerAutoDispatchLaunch), not toward emitting a
  // duplicate breadcrumb for a launch that already has one.
  const entries = [
    { event: 'launch', taskId: '640', workspaceRef: 'workspace:12', ts: '2026-08-03T00:00:00Z' },
    { event: 'dead', taskId: '640', workspaceRef: 'workspace:12', ts: '2026-08-03T00:00:00Z' },
  ];
  const idle = [{ ref: 'workspace:12', title: 'current healthy task' }];
  assert.deepEqual(deadBreadcrumbs(idle, entries), []);
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

test('a slow-boot launch is journaled unverified but NOT dead (card #705)', () => {
  const args = { taskId: 705, subject: 'slow boot', workspaceRef: 'workspace:230', failureReason: 'slow-boot-timeout' };

  // Confirmed-dead (injection never ran): the breadcrumb the pruner and the
  // 2-death guard need.
  const dead = failedLaunchEntries({ ...args, deadConfirmed: true });
  assert.deepEqual(dead.map(e => e.event), ['dead', 'launch']);

  // Still booting: its wrapper process is alive, so calling it dead would mark
  // a LIVE session as a corpse and burn one of the task's two allowed deaths.
  const booting = failedLaunchEntries({ ...args, deadConfirmed: false });
  assert.deepEqual(booting.map(e => e.event), ['launch']);
  assert.equal(booting[0].unverified, true, 'the attempt must still be tracked');
  assert.equal(deadBreadcrumbs([], booting).length, 0);

  // Default stays dead-confirmed — every pre-#705 caller keeps its behavior.
  assert.deepEqual(failedLaunchEntries(args).map(e => e.event), ['dead', 'launch']);
});

test('a retry verdict never closes the workspace or drops its attribution (owner decision 2026-08-13, Option A)', () => {
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
  // dispatch fix afb00813dac (owner-approved Option A, 2026-08-13): the old
  // 'retry' branch closed attempt 1's workspace on an unreliable
  // injection-never-ran verdict, which was destroying LIVE sessions. It now
  // keeps the workspace and stops relaunching instead — closeWorkspace must
  // never reappear in this file.
  assert.doesNotMatch(src, /closeWorkspace\(ws\.ref\)/);
});

test('bsc-next dispatches with the long verify window + late-adopt grace, and journals failures', () => {
  const src = fs.readFileSync(new URL('../bsc-next.js', import.meta.url), 'utf8');
  // The 30s default is what produced the false failures; bsc-next must pass the
  // same window the opening-night launcher has used since its own 2026-07-24
  // false CRITICAL, and must ask for late adoption.
  assert.match(src, /verifyTimeoutSec:\s*90,\s*lateAdoptSec:\s*60/);
  assert.match(src, /failedLaunchEntries/);
});

// ── Owner-closed workspaces (task #578) ────────────────────────────────────
const {
  vanishedBreadcrumbs, vanishEpoch, vanishEpochEntry, pruneClosedEntry,
  parkedTasks, unparkEntry, isWorkspaceRef,
} = require('./dispatch-ledger.js');

const EPOCH = '2026-08-01T00:00:00.000Z';
const AFTER = '2026-08-02T12:00:00.000Z';
const BEFORE = '2026-07-20T12:00:00.000Z';
// `now` for tests that don't care about the historical-exclusion grace: well
// after EPOCH but still comfortably inside HISTORICAL_EXCLUSION_GRACE_MS
// (72h), so pre-epoch behavior is unaffected and these tests exercise
// everything else unchanged.
const NOW = Date.parse(AFTER);
const launch = (o) => ({ event: 'launch', taskId: '1', subject: 's', ...o });

test('vanishedBreadcrumbs: absent workspace after the epoch parks its task', () => {
  const out = vanishedBreadcrumbs(
    new Set(['workspace:2']),
    [launch({ workspaceRef: 'workspace:1', ts: AFTER, notionId: 'abc' })],
    { epochTs: EPOCH, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'vanished');
  assert.equal(out[0].workspaceRef, 'workspace:1');
  assert.equal(out[0].notionId, 'abc');
});

test('vanishedBreadcrumbs: a workspace still listed never parks', () => {
  assert.deepEqual(vanishedBreadcrumbs(
    new Set(['workspace:1']),
    [launch({ workspaceRef: 'workspace:1', ts: AFTER })],
    { epochTs: EPOCH, now: NOW }), []);
});

test('vanishedBreadcrumbs: pre-epoch launches are history, not parks (within the grace window)', () => {
  assert.deepEqual(vanishedBreadcrumbs(
    new Set(['workspace:9']),
    [launch({ workspaceRef: 'workspace:1', ts: BEFORE })],
    { epochTs: EPOCH, now: Date.parse(EPOCH) + 1000 }), []);
});

test('vanishedBreadcrumbs: pre-epoch launches become eligible once the historical-exclusion grace elapses (card #801)', () => {
  // Card #801 root cause: the epoch's ONLY job is protecting the FIRST sweep
  // from mass-parking historical tabs. A permanent exclusion instead made
  // any pre-epoch launch immortal — never reconciled no matter how long its
  // tab was actually gone. Past the grace, it rejoins the normal path.
  const out = vanishedBreadcrumbs(
    new Set(['workspace:9']),
    [launch({ workspaceRef: 'workspace:1', ts: BEFORE, notionId: 'abc' })],
    { epochTs: EPOCH, now: Date.parse(EPOCH) + 72 * 60 * 60 * 1000 + 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].workspaceRef, 'workspace:1');
});

test('vanishedBreadcrumbs: a pre-epoch ref superseded by a newer OPEN launch for the same task never parks, even past the grace', () => {
  // Per-ref iteration alone would treat the dead pre-epoch ref as an
  // independent candidate once the grace expires — but the task itself
  // moved on to workspace:2, which is still open (no terminal event, still
  // live in liveRefs). Parking the stale workspace:1 candidate would
  // incorrectly flip that task's Notion card to Paused mid-flight.
  const out = vanishedBreadcrumbs(
    new Set(['workspace:2']),
    [
      launch({ taskId: '1', workspaceRef: 'workspace:1', ts: BEFORE }),
      launch({ taskId: '1', workspaceRef: 'workspace:2', ts: AFTER }),
    ],
    { epochTs: EPOCH, now: Date.parse(EPOCH) + 72 * 60 * 60 * 1000 + 1 });
  assert.deepEqual(out, []);
});

test('vanishedBreadcrumbs: a pre-epoch ref is NOT suppressed when the "newer" launch for the task is also dead (Codex adversarial-review catch, card #801 ship-check)', () => {
  // Both refs are absent from liveRefs — the newer launch is exactly as
  // dead as the older one, so "a newer launch exists" alone must NOT
  // suppress the older, notionId-bearing ref. Requiring liveRefs.has() on
  // the newer launch's ref (not just "no terminal event yet") is what makes
  // this distinguishable from the genuinely-superseded case above.
  const out = vanishedBreadcrumbs(
    new Set(['workspace:9']), // neither workspace:1 nor workspace:2 is live
    [
      launch({ taskId: '1', workspaceRef: 'workspace:1', ts: BEFORE, notionId: 'abc' }),
      launch({ taskId: '1', workspaceRef: 'workspace:2', ts: AFTER }), // also dead, no notionId
    ],
    { epochTs: EPOCH, now: Date.parse(EPOCH) + 72 * 60 * 60 * 1000 + 1 });
  const refs = out.map(b => b.workspaceRef).sort();
  assert.deepEqual(refs, ['workspace:1', 'workspace:2'], 'both dead refs become candidates — the notionId-bearing one must not be silently swallowed');
  assert.equal(out.find(b => b.workspaceRef === 'workspace:1').notionId, 'abc');
});

test('vanishedBreadcrumbs: requires now (ms epoch)', () => {
  const entries = [launch({ workspaceRef: 'workspace:1', ts: AFTER })];
  assert.throws(() => vanishedBreadcrumbs(new Set(['workspace:9']), entries, { epochTs: EPOCH }), /now/);
  assert.throws(() => vanishedBreadcrumbs(new Set(['workspace:9']), entries, { epochTs: EPOCH, now: NaN }), /now/);
});

test('vanishedBreadcrumbs: a malformed epoch timestamp fails closed (never expires the grace)', () => {
  const out = vanishedBreadcrumbs(
    new Set(['workspace:9']),
    [launch({ workspaceRef: 'workspace:1', ts: BEFORE })],
    { epochTs: 'not-a-date', now: Date.parse(EPOCH) + 365 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(out, [], 'NaN epochMs must never let pre-epoch history through');
});

test('vanishedBreadcrumbs: fails closed with no epoch and on an empty cmux listing', () => {
  const entries = [launch({ workspaceRef: 'workspace:1', ts: AFTER })];
  assert.deepEqual(vanishedBreadcrumbs(new Set(['workspace:9']), entries, { epochTs: null, now: NOW }), [],
    'no epoch recorded must never park');
  assert.deepEqual(vanishedBreadcrumbs(new Set(), entries, { epochTs: EPOCH, now: NOW }), [],
    'empty listing = cmux restarted/crashed, not 200 closed tabs');
  assert.throws(() => vanishedBreadcrumbs(['workspace:9'], entries, { epochTs: EPOCH, now: NOW }), /Set/);
});

test('vanishedBreadcrumbs: headless and ref-less launches are never workspace-shaped', () => {
  assert.equal(isWorkspaceRef('headless:761'), false);
  assert.equal(isWorkspaceRef(undefined), false);
  assert.equal(isWorkspaceRef('workspace:12'), true);
  assert.deepEqual(vanishedBreadcrumbs(
    new Set(['workspace:9']),
    [launch({ workspaceRef: 'headless:1', ts: AFTER }), launch({ taskId: '2', ts: AFTER })],
    { epochTs: EPOCH, now: NOW }), [], 'headless dispatches are never in a cmux listing — parking them is the #578 bug');
});

test('vanishedBreadcrumbs: a terminal entry after the launch means already reconciled', () => {
  for (const ev of ['dead', 'vanished', 'prune-closed']) {
    assert.deepEqual(vanishedBreadcrumbs(
      new Set(['workspace:9']),
      [launch({ workspaceRef: 'workspace:1', ts: AFTER }),
        { event: ev, taskId: '1', workspaceRef: 'workspace:1', ts: '2026-08-02T13:00:00.000Z' }],
      { epochTs: EPOCH, now: NOW }), [], `${ev} should terminate the launch`);
  }
});

test('vanishedBreadcrumbs: a ref relaunched after its close parks again (cmux ref reuse)', () => {
  const out = vanishedBreadcrumbs(
    new Set(['workspace:9']),
    [launch({ workspaceRef: 'workspace:1', ts: '2026-08-02T10:00:00.000Z' }),
      { event: 'prune-closed', taskId: '1', workspaceRef: 'workspace:1', ts: '2026-08-02T11:00:00.000Z' },
      launch({ taskId: '77', workspaceRef: 'workspace:1', ts: '2026-08-02T12:00:00.000Z' })],
    { epochTs: EPOCH, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].taskId, '77', 'the LATEST launch owns the ref, not the first');
});

test('vanishedBreadcrumbs is idempotent: its own output terminates the next sweep', () => {
  const entries = [launch({ workspaceRef: 'workspace:1', ts: AFTER })];
  const first = vanishedBreadcrumbs(new Set(['workspace:9']), entries, { epochTs: EPOCH, now: NOW });
  assert.equal(first.length, 1);
  const replayed = entries.concat(first.map(e => ({ ...e, ts: '2026-08-02T14:00:00.000Z' })));
  assert.deepEqual(vanishedBreadcrumbs(new Set(['workspace:9']), replayed, { epochTs: EPOCH, now: NOW }), []);
});

test('vanishEpoch reads the stamp; vanishEpochEntry is appendEntry-shaped', () => {
  assert.equal(vanishEpoch([]), null);
  assert.equal(vanishEpoch([{ event: 'vanish-epoch', ts: EPOCH }]), EPOCH);
  const p = tmpLedger();
  const written = appendEntry(vanishEpochEntry(), p);
  assert.ok(written.ts, 'must satisfy appendEntry validation (event + taskId)');
  assert.equal(vanishEpoch(readEntries(p)), written.ts);
});

// ── Restart-vs-close disambiguation (task #883) ────────────────────────────
const {
  titleMatchesSubject, findRenumberedWorkspace, openWorkspaceLaunchCount,
  looksLikeRestart, openTaskWorkspaceLaunches,
} = require('./dispatch-ledger.js');

test('titleMatchesSubject: glyph/project-prefix tolerant, requires a >=20-char common prefix', () => {
  const subject = 'Session-system overhaul S0: hook foundations for the reconciler';
  assert.equal(titleMatchesSubject('🤖⚡ Data·Session-system overhaul S0: hook foundations', subject), true);
  assert.equal(titleMatchesSubject('⠂ Session-system overhaul S0: hook foundations', subject), true);
  assert.equal(titleMatchesSubject('✅ Session-system overhaul S0: hook foundations', subject), true, 'match is title-shape only; done-ness is the caller\'s job');
  assert.equal(titleMatchesSubject('Unrelated card about something else', subject), false);
  assert.equal(titleMatchesSubject('short', 'short'), false, 'too short to be evidence even on an exact match');
});

test('findRenumberedWorkspace: finds the same session under a new ref, excludes already-claimed refs', () => {
  const launch = { taskId: '853', subject: 'Session-system overhaul S0: hook foundations for the reconciler', workspaceRef: 'workspace:12' };
  const live = [
    { ref: 'workspace:3', title: 'Unrelated' },
    { ref: 'workspace:41', title: '🤖⚡ Data·Session-system overhaul S0: hook foundations' },
  ];
  assert.equal(findRenumberedWorkspace(launch, live).ref, 'workspace:41');
  assert.equal(findRenumberedWorkspace(launch, live, new Set(['workspace:41'])), null, 'excludeRefs stops double-claiming');
  assert.equal(findRenumberedWorkspace(launch, []), null);
  assert.equal(findRenumberedWorkspace(launch, [{ ref: 'workspace:3', title: 'Unrelated' }]), null);
});

test('openWorkspaceLaunchCount: counts post-epoch, non-terminal workspace launches only', () => {
  const entries = [
    launch({ taskId: '1', workspaceRef: 'workspace:1', ts: AFTER }),
    launch({ taskId: '2', workspaceRef: 'workspace:2', ts: AFTER }),
    { event: 'dead', taskId: '2', workspaceRef: 'workspace:2', ts: '2026-08-02T13:00:00.000Z' },
    launch({ taskId: '3', workspaceRef: 'workspace:3', ts: BEFORE }), // pre-epoch
    launch({ taskId: '4', workspaceRef: 'headless:4', ts: AFTER }),  // not workspace-shaped
  ];
  assert.equal(openWorkspaceLaunchCount(entries, { epochTs: EPOCH, now: NOW }), 1);
  assert.equal(openWorkspaceLaunchCount(entries, { epochTs: null, now: NOW }), 0, 'no epoch = nothing counted');
  assert.throws(() => openWorkspaceLaunchCount(entries, { epochTs: EPOCH }), /now/);
});

test('openWorkspaceLaunchCount: pre-epoch launches join the count once the grace elapses, matching vanishedBreadcrumbs (card #801 ship-check)', () => {
  const entries = [
    launch({ taskId: '1', workspaceRef: 'workspace:1', ts: AFTER }),
    launch({ taskId: '3', workspaceRef: 'workspace:3', ts: BEFORE }), // pre-epoch
  ];
  const withinGrace = Date.parse(EPOCH) + 1000;
  const pastGrace = Date.parse(EPOCH) + 72 * 60 * 60 * 1000 + 1;
  assert.equal(openWorkspaceLaunchCount(entries, { epochTs: EPOCH, now: withinGrace }), 1, 'pre-epoch launch not yet counted');
  assert.equal(openWorkspaceLaunchCount(entries, { epochTs: EPOCH, now: pastGrace }), 2, 'pre-epoch launch now counted — same population vanishedBreadcrumbs draws candidates from');
});

test('looksLikeRestart: requires both a minimum absolute count and a majority fraction', () => {
  assert.equal(looksLikeRestart(1, 10), false, 'a single ordinary tab-close never trips this');
  assert.equal(looksLikeRestart(2, 3), false, 'below RESTART_MIN_COUNT even at high fraction');
  assert.equal(looksLikeRestart(3, 20), false, 'below RESTART_FRACTION even at the count floor');
  assert.equal(looksLikeRestart(5, 8), true);
  assert.equal(looksLikeRestart(5, 0), false, 'zero denominator never restart-flags');
});

test('openTaskWorkspaceLaunches: latest workspace-shaped launch per task, excludes reconciled and headless', () => {
  const entries = [
    launch({ taskId: '1', workspaceRef: 'workspace:1', ts: AFTER }),
    launch({ taskId: '2', workspaceRef: 'workspace:2', ts: AFTER }),
    { event: 'dead', taskId: '2', workspaceRef: 'workspace:2', ts: '2026-08-02T13:00:00.000Z' },
    launch({ taskId: '3', workspaceRef: 'headless:3', ts: AFTER }),
    launch({ taskId: '1', workspaceRef: 'workspace:99', ts: '2026-08-02T14:00:00.000Z' }), // re-dispatch supersedes
  ];
  const open = openTaskWorkspaceLaunches(entries);
  assert.deepEqual([...open.keys()].sort(), ['1']);
  assert.equal(open.get('1').workspaceRef, 'workspace:99', 'the latest launch for the task wins');
});

test('pruneClosedEntry only journals workspaces bsc-next actually launched', () => {
  const entries = [launch({ workspaceRef: 'workspace:1', ts: AFTER })];
  const e = pruneClosedEntry({ ref: 'workspace:1', title: '✅ done' }, entries);
  assert.equal(e.event, 'prune-closed');
  assert.equal(e.taskId, '1');
  assert.equal(pruneClosedEntry({ ref: 'workspace:44', title: 'hand-opened tab' }, entries), null);
});

// Scheduled-tick idempotence (adversarial review 2026-08-02): a ✅ workspace
// bsc-prune skips every sweep must journal at most ONE terminal breadcrumb
// per launch, not one per 5-min tick.
test('pruneClosedEntry: already-terminal ref journals nothing; a re-dispatch after the terminal journals again', () => {
  const base = [launch({ workspaceRef: 'workspace:1', ts: AFTER })];
  const first = pruneClosedEntry({ ref: 'workspace:1', title: '✅ done' }, base);
  assert.equal(first.event, 'prune-closed');
  // Same launch, terminal already recorded → dedup to null
  const withTerminal = base.concat([{ ...first, ts: new Date(Date.parse(AFTER) + 1000).toISOString() }]);
  assert.equal(pruneClosedEntry({ ref: 'workspace:1', title: '✅ done' }, withTerminal), null);
});

// ── isLedgerAutoDispatched (card #971) ──────────────────────────────────────
const { isLedgerAutoDispatched, findLedgerAutoDispatchLaunch } = require('./dispatch-ledger.js');

const LONG_SUBJECT = 'Homepage/list-page RSC payload duplicates criticScore objects ~10-50x per unique show';
const glyphLostTitle = '✅ ' + LONG_SUBJECT.slice(0, 40); // status-reflecting rename: prefix preserved, glyph gone

test('isLedgerAutoDispatched: true for a ref with an unreconciled launch record whose title still matches the subject', () => {
  const entries = [launch({ workspaceRef: 'workspace:5', subject: LONG_SUBJECT, ts: AFTER })];
  assert.equal(isLedgerAutoDispatched('workspace:5', glyphLostTitle, entries), true);
});

test('isLedgerAutoDispatched: false when no launch record exists for the ref at all', () => {
  const entries = [launch({ workspaceRef: 'workspace:5', subject: LONG_SUBJECT, ts: AFTER })];
  assert.equal(isLedgerAutoDispatched('workspace:9', glyphLostTitle, entries), false);
  assert.equal(isLedgerAutoDispatched('workspace:9', glyphLostTitle, []), false);
});

// Second-signal requirement (Codex adversarial review P0, 2026-08-03): an
// unreconciled ledger launch alone is not enough — the live title must still
// resemble the launch's own subject. Otherwise a ref that was genuinely
// closed (real 'prune-closed', no dead/vanished/remapped left to see) and
// recycled to a totally unrelated owner-opened ✅ tab would inherit the old
// launch's auto-dispatch status.
test('isLedgerAutoDispatched: false when the ledger has an unreconciled launch but the title is unrelated (recycled-ref safety)', () => {
  const entries = [launch({ workspaceRef: 'workspace:5', subject: LONG_SUBJECT, ts: AFTER })];
  assert.equal(isLedgerAutoDispatched('workspace:5', '✅ Some completely different owner-opened tab', entries), false);
});

// The recycled-ref hazard (card 3b1637c5): once the ledger's own terminal
// event says this ref's launch story is over, the ref's CURRENT occupant may
// be an unrelated owner-opened tab after a recycle — must not be trusted,
// even if the title happens to still match (belt-and-suspenders).
test('findLedgerAutoDispatchLaunch: null once dead/vanished/remapped reconciles the launch (recycled-ref safety)', () => {
  for (const ev of ['dead', 'vanished', 'remapped']) {
    const entries = [
      launch({ workspaceRef: 'workspace:5', subject: LONG_SUBJECT, ts: AFTER }),
      { event: ev, taskId: '1', workspaceRef: 'workspace:5', ts: '2026-08-02T13:00:00.000Z' },
    ];
    assert.equal(findLedgerAutoDispatchLaunch('workspace:5', entries), null, `${ev} should reconcile the launch`);
    assert.equal(isLedgerAutoDispatched('workspace:5', glyphLostTitle, entries), false, `${ev} should reconcile the launch`);
  }
});

// 'prune-closed' is DELIBERATELY excluded here (unlike TERMINAL_LAUNCH_EVENTS'
// other three) — see LEDGER_DISPATCH_RECONCILED_EVENTS' header comment: it is
// written for EVERY ✅ tab before pruneDone even runs, including ones it goes
// on to skip, so treating it as reconciling would self-defeat this exact
// function on the first sweep after every glyph loss (reproduced live against
// production data 2026-08-03, workspace:124).
test('isLedgerAutoDispatched: a same-tick prune-closed pre-write does NOT reconcile the launch (self-defeat guard)', () => {
  const entries = [
    launch({ workspaceRef: 'workspace:124', subject: LONG_SUBJECT, ts: '2026-08-03T15:28:02.196Z' }),
    { event: 'prune-closed', taskId: '551', workspaceRef: 'workspace:124', ts: '2026-08-03T15:51:42.544Z' },
  ];
  const liveTitle = '✅ Homepage/list-page RSC payload duplicates criticSc'; // captured live, 2026-08-03
  assert.equal(isLedgerAutoDispatched('workspace:124', liveTitle, entries), true, 'still-open tab must stay auto-dispatched despite the speculative prune-closed write');
});

test('isLedgerAutoDispatched: a re-dispatch after the terminal event is trusted again', () => {
  const entries = [
    launch({ workspaceRef: 'workspace:5', subject: 'an old unrelated task nobody cares about anymore', ts: BEFORE }),
    { event: 'dead', taskId: '1', workspaceRef: 'workspace:5', ts: AFTER },
    launch({ taskId: '2', workspaceRef: 'workspace:5', subject: LONG_SUBJECT, ts: '2026-08-02T14:00:00.000Z' }),
  ];
  assert.equal(isLedgerAutoDispatched('workspace:5', glyphLostTitle, entries), true);
});

test('isLedgerAutoDispatched: never true for non-workspace-shaped refs (headless/undefined)', () => {
  const entries = [launch({ workspaceRef: 'headless:5', subject: LONG_SUBJECT, ts: AFTER })];
  assert.equal(isLedgerAutoDispatched('headless:5', glyphLostTitle, entries), false);
  assert.equal(isLedgerAutoDispatched(undefined, glyphLostTitle, entries), false);
});

test('parkedTasks: vanished parks, unpark and a later launch both clear it', () => {
  const v = { event: 'vanished', taskId: '1', workspaceRef: 'workspace:1', ts: AFTER };
  assert.equal(parkedTasks([v]).has('1'), true);
  assert.equal(parkedTasks([v, unparkEntry({ taskId: 1 })]).has('1'), false);
  assert.equal(parkedTasks([v, launch({ workspaceRef: 'workspace:5' })]).has('1'), false,
    '--force dispatching anyway IS the unpark — the park must never be a trap');
  assert.equal(parkedTasks([v]).get('1').workspaceRef, 'workspace:1');
});

test('parkedTasks: a vanished task does NOT count toward the dead-attempt limit', () => {
  const entries = [{ event: 'vanished', taskId: '1', workspaceRef: 'workspace:1', ts: AFTER },
    { event: 'vanished', taskId: '1', workspaceRef: 'workspace:2', ts: AFTER }];
  assert.equal(deadAttemptsForTask('1', entries).length, 0,
    'closing a tab twice must not burn the 2-death budget — it parks instead');
});

// ── detectLauncherOutage (card #900) ────────────────────────────────────────
test('detectLauncherOutage: fires only when injection-never-ran deaths span 3+ distinct tasks', () => {
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const death = (taskId, ref, minsAgo) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: `command injection never ran (no wrapper process appeared) in ${ref}`,
    ts: new Date(now - minsAgo * 60000).toISOString(),
  });
  // Same task retried twice — not cross-task evidence.
  const singleTask = [death('855', 'workspace:61', 10), death('855', 'workspace:63', 5)];
  assert.equal(detectLauncherOutage(singleTask, { now }).outage, false);

  // 3 distinct tasks, all within the lookback window.
  const crossTask = [death('897', 'workspace:60', 28), death('855', 'workspace:61', 25),
    death('857', 'workspace:65', 20)];
  const r = detectLauncherOutage(crossTask, { now });
  assert.equal(r.outage, true);
  assert.deepEqual(r.taskIds.sort(), ['855', '857', '897']);
});

test('detectLauncherOutage: ignores deaths outside the lookback window', () => {
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const old = ['897', '855', '857'].map((taskId, i) => ({
    event: 'dead', taskId, workspaceRef: `workspace:${i}`,
    failureReason: 'command injection never ran (no wrapper process appeared)',
    ts: new Date(now - 90 * 60000).toISOString(), // 90 min ago, default lookback is 30
  }));
  assert.equal(detectLauncherOutage(old, { now }).outage, false);
});

test('detectLauncherOutage: a verified success after the failures clears the outage', () => {
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const death = (taskId, ref, minsAgo) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: 'command injection never ran (no wrapper process appeared)',
    ts: new Date(now - minsAgo * 60000).toISOString(),
  });
  const entries = [
    death('897', 'workspace:60', 20), death('855', 'workspace:61', 15), death('857', 'workspace:65', 10),
    { event: 'launch', taskId: '900', workspaceRef: 'workspace:72', ts: new Date(now - 5 * 60000).toISOString() },
  ];
  const r = detectLauncherOutage(entries, { now });
  assert.equal(r.outage, false);
  assert.equal(r.recovered, true);
});

test('detectLauncherOutage: an UNVERIFIED launch entry (itself a failed attempt) does not count as recovery', () => {
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const death = (taskId, ref, minsAgo) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: 'command injection never ran (no wrapper process appeared)',
    ts: new Date(now - minsAgo * 60000).toISOString(),
  });
  const entries = [
    death('897', 'workspace:60', 20), death('855', 'workspace:61', 15), death('857', 'workspace:65', 10),
    // failedLaunchEntries always pairs a 'dead' with an unverified 'launch' — this must not look like recovery.
    { event: 'launch', taskId: '857', workspaceRef: 'workspace:65', unverified: true, ts: new Date(now - 10 * 60000).toISOString() },
  ];
  assert.equal(detectLauncherOutage(entries, { now }).outage, true);
});

test('detectLauncherOutage: a success SANDWICHED between failures does not mask the outage (Codex P0, 2026-08-03)', () => {
  // failure -> success -> 3 MORE failures. Comparing against the oldest death
  // would call this "recovered" the instant the one success landed, even
  // though the launcher broke again right after — the ledger's actual
  // account of what's happening RIGHT NOW must win.
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const death = (taskId, ref, minsAgo) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: 'command injection never ran (no wrapper process appeared)',
    ts: new Date(now - minsAgo * 60000).toISOString(),
  });
  const entries = [
    death('897', 'workspace:60', 25),
    { event: 'launch', taskId: '900', workspaceRef: 'workspace:72', ts: new Date(now - 22 * 60000).toISOString() },
    death('855', 'workspace:61', 15), death('857', 'workspace:65', 10), death('902', 'workspace:67', 5),
  ];
  const r = detectLauncherOutage(entries, { now });
  assert.equal(r.outage, true, 'three fresh failures after the recovery must still alarm');
  assert.equal(r.recovered, undefined);
});

test('detectLauncherOutage: "wrapper exited" is NOT outage evidence — injection ran, the command itself died (Codex P0, 2026-08-03)', () => {
  // A wrapper that ran and then exited proves the typed command DID start —
  // that's a per-task crash/bad-command signature, not cmux refusing to
  // inject. Conflating the two would raise a false "cmux is broken" alarm
  // off three unrelated task bugs.
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const exited = (taskId, ref) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: 'launch wrapper exited without claude registering',
    ts: new Date(now - 5 * 60000).toISOString(),
  });
  const entries = ['1', '2', '3'].map((t, i) => exited(t, `workspace:${i}`));
  assert.equal(detectLauncherOutage(entries, { now }).outage, false);
});

test('detectLauncherOutage: slow-boot-timeout deaths (claude still booting) are not outage evidence', () => {
  const now = Date.parse('2026-08-03T03:00:00.000Z');
  const bootDeath = (taskId, ref) => ({
    event: 'dead', taskId, workspaceRef: ref,
    failureReason: 'claude still had not registered at the slow-boot cap (wrapper process still alive — may yet come up)',
    ts: new Date(now - 5 * 60000).toISOString(),
  });
  const entries = ['1', '2', '3'].map((t, i) => bootDeath(t, `workspace:${i}`));
  assert.equal(detectLauncherOutage(entries, { now }).outage, false,
    'a live-wrapper slow boot is not the launcher failing to inject — must not alarm on it');
});

// ── followRetryChain (task #1184 S1) ────────────────────────────────────────
import { followRetryChain, JOB_EVENTS } from './dispatch-ledger.js';

const chainSpawn = (jobId, ts, extra = {}) => ({ event: JOB_EVENTS.SPAWNED, taskId: '7', jobId, ts, ...extra });
const chainRetried = (jobId, ts, sessionId) => ({ event: JOB_EVENTS.RETRIED, taskId: '7', jobId, ts, sessionId });
const chainDone = (jobId, ts) => ({ event: JOB_EVENTS.DONE, taskId: '7', jobId, ts });

test('followRetryChain: prefers the CAUSAL successor (resumeOfSession match) over any other spawn', () => {
  const entries = [
    chainSpawn('j1', '2026-08-10T10:00:00Z'),
    chainRetried('j1', '2026-08-10T12:00:00Z', 'sess-A'),
    // A manual headless job spawned in the gap — must NOT be credited.
    chainSpawn('manual', '2026-08-10T12:01:00Z'),
    chainSpawn('j2', '2026-08-10T12:02:00Z', { resumed: true, resumeOfSession: 'sess-A' }),
    chainDone('j2', '2026-08-10T13:00:00Z'),
  ];
  const job = followRetryChain(entries, '7', 'j1');
  assert.equal(job.jobId, 'j2');
  assert.equal(job.event, JOB_EVENTS.DONE);
});

test('followRetryChain: fallback for pre-stamp entries requires the spawn be marked resumed', () => {
  const entries = [
    chainSpawn('j1', '2026-08-10T10:00:00Z'),
    chainRetried('j1', '2026-08-10T12:00:00Z', 'sess-A'),
    chainSpawn('manual', '2026-08-10T12:01:00Z'),                    // resumed absent — never credited
    chainSpawn('j2', '2026-08-10T12:02:00Z', { resumed: true }),     // legacy resume, no session stamp
  ];
  assert.equal(followRetryChain(entries, '7', 'j1').jobId, 'j2');
});

test('followRetryChain: a chain ending at RETRIED (successor not spawned) returns the RETRIED job as-is', () => {
  const entries = [chainSpawn('j1', '2026-08-10T10:00:00Z'), chainRetried('j1', '2026-08-10T12:00:00Z', 'sess-A')];
  const job = followRetryChain(entries, '7', 'j1');
  assert.equal(job.jobId, 'j1');
  assert.equal(job.event, JOB_EVENTS.RETRIED, 'callers treat this as in-flight within their orphan bound');
});

test('followRetryChain: non-retried jobs pass through untouched', () => {
  const entries = [chainSpawn('j1', '2026-08-10T10:00:00Z'), chainDone('j1', '2026-08-10T11:00:00Z')];
  assert.equal(followRetryChain(entries, '7', 'j1').event, JOB_EVENTS.DONE);
});

// ── classifyDeadAttemptsForTask / dispatchCapDecision (card #1233) ─────────
// The 2-death dispatch cap used to count EVERY dead attempt equally, so a
// task that died twice because cmux's terminal surface never rendered got
// the same "investigate the task" refusal as one that actually booted and
// crashed twice. These reuse dispatch-attempts.js's own dead/unverified
// classification (not a re-derived pairing window) to tell the two apart.
const cmuxLaunch = (ts, ref, taskId, extra = {}) => ({
  ts, event: 'launch', taskId, subject: `task ${taskId}`, workspaceRef: ref, model: 'sonnet', ...extra,
});
const cmuxDead = (ts, ref, taskId, failureReason = 'command injection never ran') => ({
  ts, event: 'dead', taskId, subject: `task ${taskId}`, workspaceRef: ref, failureReason, title: null,
});

test('classifyDeadAttemptsForTask: 2 infra deaths (paired unverified launch, terminal surface never rendered) are not substantive', () => {
  const entries = [
    cmuxDead('2026-08-10T10:00:00.000Z', 'workspace:501', '1233a'),
    cmuxLaunch('2026-08-10T10:00:00.002Z', 'workspace:501', '1233a', { unverified: true }),
    cmuxDead('2026-08-10T11:00:00.000Z', 'workspace:502', '1233a'),
    cmuxLaunch('2026-08-10T11:00:00.002Z', 'workspace:502', '1233a', { unverified: true }),
  ];
  const { substantive, infra } = classifyDeadAttemptsForTask('1233a', entries);
  assert.equal(substantive.length, 0);
  assert.equal(infra.length, 2);
  assert.equal(substantiveDeadAttemptsForTask('1233a', entries).length, 0);
});

test('classifyDeadAttemptsForTask: 2 substantive deaths (verified launch, later dead breadcrumb) stay substantive', () => {
  const entries = [
    cmuxLaunch('2026-08-10T09:00:00.000Z', 'workspace:601', '1233b'),
    cmuxDead('2026-08-10T11:30:00.000Z', 'workspace:601', '1233b', 'workspace idle, never booted'),
    cmuxLaunch('2026-08-10T12:00:00.000Z', 'workspace:602', '1233b'),
    cmuxDead('2026-08-10T14:30:00.000Z', 'workspace:602', '1233b', 'workspace idle, never booted'),
  ];
  const { substantive, infra } = classifyDeadAttemptsForTask('1233b', entries);
  assert.equal(substantive.length, 2);
  assert.equal(infra.length, 0);
  assert.equal(substantiveDeadAttemptsForTask('1233b', entries).length, 2);
});

test('dispatchCapDecision: 2 infra deaths do not block dispatch; 2 substantive deaths do', () => {
  const infraOnly = [
    cmuxDead('2026-08-10T10:00:00.000Z', 'workspace:701', '1233c'),
    cmuxLaunch('2026-08-10T10:00:00.002Z', 'workspace:701', '1233c', { unverified: true }),
    cmuxDead('2026-08-10T11:00:00.000Z', 'workspace:702', '1233c'),
    cmuxLaunch('2026-08-10T11:00:00.002Z', 'workspace:702', '1233c', { unverified: true }),
  ];
  const infraDecision = dispatchCapDecision('1233c', infraOnly);
  assert.equal(infraDecision.blocked, false);

  const substantiveOnly = [
    cmuxLaunch('2026-08-10T09:00:00.000Z', 'workspace:801', '1233d'),
    cmuxDead('2026-08-10T11:30:00.000Z', 'workspace:801', '1233d', 'workspace idle, never booted'),
    cmuxLaunch('2026-08-10T12:00:00.000Z', 'workspace:802', '1233d'),
    cmuxDead('2026-08-10T14:30:00.000Z', 'workspace:802', '1233d', 'workspace idle, never booted'),
  ];
  const substantiveDecision = dispatchCapDecision('1233d', substantiveOnly);
  assert.equal(substantiveDecision.blocked, true);
  assert.equal(substantiveDecision.reason, 'substantive');
});

test('classifyDeadAttemptsForTask: an unpairable dead row (no ts, no matching launch) fails closed as substantive, never silently dropped', () => {
  const entries = [
    { event: 'dead', taskId: '1233e', workspaceRef: 'workspace:900' },
    { event: 'dead', taskId: '1233e', workspaceRef: 'workspace:901' },
  ];
  const { substantive, infra } = classifyDeadAttemptsForTask('1233e', entries);
  assert.equal(substantive.length, 2, 'both entries preserved — deadAttemptsForTask\'s full list, just partitioned');
  assert.equal(infra.length, 0);
});

test('classifyDeadAttemptsForTask: job-failed/job-orphaned deaths are always substantive (the wrapper already ran)', () => {
  const entries = [
    { ts: '2026-08-10T10:00:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: '1233f', jobId: 'j1' },
    { ts: '2026-08-10T10:05:00.000Z', event: JOB_EVENTS.FAILED, taskId: '1233f', jobId: 'j1' },
  ];
  const { substantive, infra } = classifyDeadAttemptsForTask('1233f', entries);
  assert.equal(substantive.length, 1);
  assert.equal(infra.length, 0);
});

test('classifyDeadAttemptsForTask: recycled workspaceRef across two DIFFERENT tasks does not cross-contaminate infra/substantive', () => {
  // Same ref, one infra death for task A, one substantive death for task B —
  // scoping candidates to (taskId, workspaceRef) must keep them apart.
  const entries = [
    cmuxDead('2026-08-01T10:00:00.000Z', 'workspace:55', 'A'),
    cmuxLaunch('2026-08-01T10:00:00.002Z', 'workspace:55', 'A', { unverified: true }),
    cmuxLaunch('2026-08-05T10:00:00.000Z', 'workspace:55', 'B'),
    cmuxDead('2026-08-05T12:00:00.000Z', 'workspace:55', 'B', 'workspace idle, never booted'),
  ];
  assert.equal(classifyDeadAttemptsForTask('A', entries).infra.length, 1);
  assert.equal(classifyDeadAttemptsForTask('A', entries).substantive.length, 0);
  assert.equal(classifyDeadAttemptsForTask('B', entries).infra.length, 0);
  assert.equal(classifyDeadAttemptsForTask('B', entries).substantive.length, 1);
});
