import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { main } = require('./bsc-next.js');
const { extractCiRedTarget } = require('./lib/ci-red-dispatch-heuristic.js');

// Task #598: task #584 wired evaluateCiRedClaim into pre-push-review-gate.sh
// (real enforcement — a push whose diff matches an active claim gets
// blocked) but nothing ever called appendClaim() outside a human running
// scripts/claim-ci-red.js by hand, so the ledger stayed empty in practice.
// These tests cover the two ends of the fix: the heuristic that decides
// "does this task look like a CI-red fix", and the bsc-next dispatch wiring
// that calls appendClaim automatically when it does.

test('extractCiRedTarget: "Fix main CI red: X ReferenceError" extracts the error symbol', () => {
  const task = { id: '563', subject: 'Fix main CI red: shouldShowSentiment ReferenceError + help-flag audit FP' };
  const target = extractCiRedTarget(task, null);
  assert.deepEqual(target, { symbol: 'shouldShowSentiment ReferenceError', runId: null });
});

test('extractCiRedTarget: a GH Actions run URL extracts the run id', () => {
  const task = { id: '403', subject: 'Verify Maestro E2E run green', description: 'https://github.com/thomaspryor/Broadwayscore/actions/runs/30120249897 failed' };
  const target = extractCiRedTarget(task, null);
  assert.deepEqual(target, { symbol: null, runId: '30120249897' });
});

test('extractCiRedTarget: "BSC Daily: Workflow repeat-failure: X" extracts the workflow name', () => {
  const task = { id: '417', subject: 'BSC Daily: Workflow repeat-failure: Test Suite' };
  const target = extractCiRedTarget(task, null);
  assert.deepEqual(target, { symbol: 'Test Suite', runId: null });
});

test('extractCiRedTarget: CI-red-shaped but no sharper fingerprint falls back to the subject', () => {
  const task = {
    id: '500',
    subject: 'Test Suite red on main: sylvia-off-west-end-2026 has 9 reviews from a 2023 production leaked in (wrong-production-by-date)',
  };
  const target = extractCiRedTarget(task, null);
  assert.equal(target.runId, null);
  assert.equal(target.symbol, task.subject);
});

test('extractCiRedTarget: an unrelated task returns null', () => {
  const task = { id: '6', subject: 'NYT (+ Variety) review bodies failing extraction', description: '41 legit reviews lost across 24 recent shows' };
  assert.equal(extractCiRedTarget(task, null), null);
});

test('extractCiRedTarget: checks the fetched card notes, not just the task-mirror description', () => {
  const task = { id: '999', subject: 'Investigate flaky pipeline step', description: 'see notion for details' };
  const card = { notes: 'Turns out this is CI red on main from a rebuildAllReviews TypeError in the nightly job.' };
  const target = extractCiRedTarget(task, card);
  assert.deepEqual(target, { symbol: 'rebuildAllReviews TypeError', runId: null });
});

// bsc-next dispatch wiring: main() must call appendCiRedClaim for a
// CI-red-shaped task and must NOT call it for an unrelated one. cmuxAvailable
// is stubbed false so the run takes the non-cmux branch straight to
// launchCmux — this proves the claim call happens on the real dispatch path,
// not just inside the heuristic's own unit tests.
function baseDeps(claims, launchResult = { ok: true, ref: 'workspace:1' }) {
  return {
    fetchCard: () => null,
    launchCmux: () => launchResult,
    cmuxAvailable: () => false,
    listWorkspaces: () => { throw new Error('listWorkspaces must not be called when cmuxAvailable is false'); },
    isDoneTitle: () => { throw new Error('not used'); },
    claudeAliveIn: () => { throw new Error('not used'); },
    terminalSurfaceAliveIn: () => { throw new Error('not used'); },
    readLedgerEntries: () => [],
    appendLedgerEntry: () => {},
    appendCiRedClaim: (opts) => { claims.push(opts); return { ts: '2026-07-27T00:00:00.000Z', ...opts }; },
  };
}

test('main(): dispatching a CI-red-shaped task calls appendCiRedClaim with the task id and extracted symbol', () => {
  const claims = [];
  const task = { id: '563', subject: 'Fix main CI red: shouldShowSentiment ReferenceError', description: '', status: 'pending' };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--id', '563'], { ...baseDeps(claims), loadTasks: () => [task] });
  } finally {
    console.log = origLog;
  }
  assert.equal(claims.length, 1);
  assert.equal(claims[0].taskId, '563');
  assert.equal(claims[0].symbol, 'shouldShowSentiment ReferenceError');
  assert.equal(claims[0].runId, null);
});

test('main(): dispatching an unrelated task does NOT call appendCiRedClaim', () => {
  const claims = [];
  const task = { id: '6', subject: 'NYT (+ Variety) review bodies failing extraction', description: '41 legit reviews lost across 24 recent shows', status: 'pending' };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--id', '6'], { ...baseDeps(claims), loadTasks: () => [task] });
  } finally {
    console.log = origLog;
  }
  assert.equal(claims.length, 0);
});

test('main(): a CI-red claim ledger write failure is non-fatal — dispatch still proceeds', () => {
  const task = { id: '563', subject: 'Fix main CI red: shouldShowSentiment ReferenceError', description: '', status: 'pending' };
  const deps = {
    ...baseDeps([]),
    appendCiRedClaim: () => { throw new Error('ledger write failed'); },
  };
  const logged = [];
  const errored = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => errored.push(a.join(' '));
  try {
    main(['--id', '563'], { ...deps, loadTasks: () => [task] });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.ok(errored.some(l => /WARN CI-red claim write failed/.test(l)));
  assert.ok(logged.some(l => /opened Cmux tab/.test(l)));
});

// Both regression tests below drive main() down a path that calls
// process.exit(1) — stub it to throw a sentinel instead of actually killing
// the test process (no existing test in this suite exercises a
// process.exit-reaching path, so there's no shared helper for this yet).
function withStubbedExit(fn) {
  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`__PROCESS_EXIT_${code}__`); };
  try {
    fn();
  } catch (e) {
    if (!/^__PROCESS_EXIT_\d+__$/.test(e.message)) throw e;
  } finally {
    process.exit = origExit;
  }
}

// Ship-check catch: an earlier version wrote the claim BEFORE launchCmux
// confirmed success, so a failed/unverified launch still left a claim
// sitting on the ledger — a phantom lock blocking other sessions from the
// same symbol for up to the 2h TTL even though no session ever started.
test('main(): a FAILED cmux launch does NOT call appendCiRedClaim (no phantom claim on an unverified launch)', () => {
  const claims = [];
  const task = { id: '563', subject: 'Fix main CI red: shouldShowSentiment ReferenceError', description: '', status: 'pending' };
  const failedResult = { ok: false, reason: 'claude never started', workspaceRef: 'workspace:9', command: 'claude ...', seedFile: '/tmp/seed' };
  const errored = [];
  const origErr = console.error;
  console.error = (...a) => errored.push(a.join(' '));
  try {
    withStubbedExit(() => main(['--id', '563'], { ...baseDeps(claims, failedResult), loadTasks: () => [task] }));
  } finally {
    console.error = origErr;
  }
  assert.equal(claims.length, 0);
  assert.ok(errored.some(l => /LAUNCH NOT VERIFIED/.test(l)));
});

// Same class of bug: the cmux dead-dispatch check and the duplicate-dispatch
// guard both process.exit(1) BEFORE launchCmux ever runs, from INSIDE their
// own try/catch blocks — a process.exit stub can't observe "did this guard
// actually terminate the process" without also being swallowed by that same
// catch (this codebase's guards fail open on any internal error, and a
// stubbed exit looks identical to one from where they sit), so this is
// asserted structurally instead: every recordCiRedClaim() call site in the
// source must appear strictly after both guard blocks and the launchCmuxFn
// call (or, for --exec/--headless, after their own respective guards).
test('bsc-next.js: recordCiRedClaim() is only called after each branch\'s dispatch is confirmed, never before a refusal guard', () => {
  const src = fs.readFileSync(new URL('./bsc-next.js', import.meta.url), 'utf8');
  const deadDispatchGuardIdx = src.indexOf('checkDeadDispatch(task, workspaces');
  const duplicateGuardIdx = src.indexOf('findLiveWorkspaceForTask(task, workspaces');
  const launchCmuxCallIdx = src.indexOf('const res = launchCmuxFn(');
  const resOkIdx = src.indexOf('if (res.ok) {', launchCmuxCallIdx);
  assert.ok(deadDispatchGuardIdx > 0 && duplicateGuardIdx > 0 && launchCmuxCallIdx > 0 && resOkIdx > 0, 'expected guard/launch anchors not found — source shape changed');

  const cmuxRecordIdx = src.indexOf('recordCiRedClaim();', resOkIdx);
  assert.ok(cmuxRecordIdx > resOkIdx, 'cmux path: recordCiRedClaim() must be inside the res.ok success branch');
  assert.ok(cmuxRecordIdx > deadDispatchGuardIdx && cmuxRecordIdx > duplicateGuardIdx, 'cmux path: recordCiRedClaim() must run after the dead-dispatch and duplicate-dispatch guards, not before');

  const headlessDupCheckIdx = src.indexOf('findLiveWorkspaceForTask(task, listWorkspacesFn()');
  const runJobRequireIdx = src.indexOf("require('./lib/bsc-runner.js')");
  assert.ok(headlessDupCheckIdx > 0 && runJobRequireIdx > headlessDupCheckIdx, 'expected headless guard/runJob anchors not found — source shape changed');
  const headlessRecordIdx = src.indexOf('recordCiRedClaim();', headlessDupCheckIdx);
  assert.ok(headlessRecordIdx > headlessDupCheckIdx && headlessRecordIdx < runJobRequireIdx, 'headless path: recordCiRedClaim() must run after its duplicate-tab guard and before runJob() starts the job');
});
