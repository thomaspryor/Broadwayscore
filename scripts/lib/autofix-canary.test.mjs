/**
 * Pins the daily end-to-end canary + throughput row (Digest-autofix S6, task
 * #1225, owner mandate 2026-08-10: the pipeline starved to ZERO dispatches
 * 8/5-8/9 with no trace but a /tmp launchd log). Fixture-driven, no disk I/O —
 * mirrors autofix-effectiveness.test.mjs's style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  canaryDateStr, canaryMarkerRelPath, canaryCardTitle, buildCanaryCardNotes,
  planCanaryDispatch, foldCanaryStage, assessCanaryRow, assessThroughputRow,
  ZERO_DISPATCH_ERROR_DAYS, ZERO_PASS_ERROR_DAYS, isPathAbsentFromTreeError,
} = require('./autofix-canary.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
const { extractVerifyCmd } = require('./autonomous-verify-cmd.js');
const dispatchLedger = require('./dispatch-ledger.js');
const { execFileSync } = require('node:child_process');

const NOW = Date.parse('2026-08-11T12:00:00.000Z'); // yesterday = 2026-08-10
const YESTERDAY = '2026-08-10';
const TODAY = '2026-08-11';
const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

// ── canaryDateStr / marker / title ──────────────────────────────────────────

test('canaryDateStr / canaryMarkerRelPath / canaryCardTitle are consistent', () => {
  assert.equal(canaryDateStr(new Date(NOW)), TODAY);
  assert.equal(canaryMarkerRelPath(TODAY), 'data/audit/canary-2026-08-11.marker');
  assert.equal(canaryCardTitle(TODAY), 'CANARY: touch data/audit/canary-2026-08-11.marker');
});

// ── buildCanaryCardNotes: must satisfy BOTH downstream gates ───────────────

test('buildCanaryCardNotes: carries every section the notion-brain card-quality gate requires, >=300 chars', () => {
  const notes = buildCanaryCardNotes(TODAY);
  for (const section of ['## Problem', '## Evidence', '## Suggested approach', '## Acceptance criteria']) {
    assert.ok(notes.includes(section), `missing ${section}`);
  }
  assert.ok(notes.length >= 300, `notes too short for backlog gate: ${notes.length}`);
});

test('buildCanaryCardNotes: acceptance command passes the REAL safe-form gate and arms extractVerifyCmd', () => {
  for (const dateStr of ['2026-08-11', '2026-01-01', '2026-12-31']) {
    const notes = buildCanaryCardNotes(dateStr);
    const verify = extractVerifyCmd(notes, isSafeCheckCommand);
    assert.ok(verify.cmd, `verify not armed for "${dateStr}": ${verify.reason}`);
    assert.equal(verify.cmd, `node scripts/check-canary-marker.js --date=${dateStr}`);
  }
});

// ── planCanaryDispatch: dedup ───────────────────────────────────────────────

test('planCanaryDispatch: files when no card-filed entry exists for the date', () => {
  const { shouldFile } = planCanaryDispatch({ ledgerEntries: [], dateStr: TODAY });
  assert.equal(shouldFile, true);
});

test('planCanaryDispatch: skips when already filed today (idempotent against a digest re-run)', () => {
  const { shouldFile } = planCanaryDispatch({
    ledgerEntries: [{ event: 'card-filed', date: TODAY, taskId: '1' }],
    dateStr: TODAY,
  });
  assert.equal(shouldFile, false);
});

test('planCanaryDispatch: a card filed on a DIFFERENT date does not block today', () => {
  const { shouldFile } = planCanaryDispatch({
    ledgerEntries: [{ event: 'card-filed', date: YESTERDAY, taskId: '1' }],
    dateStr: TODAY,
  });
  assert.equal(shouldFile, true);
});

// ── foldCanaryStage: every stage in the lifecycle, from fixture ledgers ────

test('foldCanaryStage: no card-filed entry at all -> not-filed', () => {
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: [], dispatchLedgerEntries: [] });
  assert.equal(r.stage, 'not-filed');
  assert.equal(r.taskId, null);
});

test('foldCanaryStage: filed, no SPAWNED seen yet -> card-filed', () => {
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '900', ts: at(20) }];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: [] });
  assert.equal(r.stage, 'card-filed');
  assert.equal(r.taskId, '900');
});

test('foldCanaryStage: SPAWNED seen, not yet terminal -> dispatched', () => {
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '901', ts: at(20) }];
  const shared = [{ event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '901', jobId: 'job-1', ts: at(19) }];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: shared });
  assert.equal(r.stage, 'dispatched');
  assert.equal(r.jobId, 'job-1');
});

test('foldCanaryStage: terminal DONE -> job-done', () => {
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '902', ts: at(20) }];
  const shared = [
    { event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '902', jobId: 'job-2', ts: at(19) },
    { event: dispatchLedger.JOB_EVENTS.DONE, taskId: '902', jobId: 'job-2', ts: at(18) },
  ];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: shared });
  assert.equal(r.stage, 'job-done');
});

test('foldCanaryStage: terminal FAILED -> job-failed', () => {
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '903', ts: at(20) }];
  const shared = [
    { event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '903', jobId: 'job-3', ts: at(19) },
    { event: dispatchLedger.JOB_EVENTS.FAILED, taskId: '903', jobId: 'job-3', ts: at(18) },
  ];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: shared });
  assert.equal(r.stage, 'job-failed');
});

test('foldCanaryStage: our own ledger recorded canary-pass -> verified-pass (wins over live lookup)', () => {
  const canaryLedger = [
    { event: 'card-filed', date: YESTERDAY, taskId: '904', ts: at(20) },
    { event: 'canary-pass', date: YESTERDAY, taskId: '904', ts: at(1) },
  ];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: [] });
  assert.equal(r.stage, 'verified-pass');
});

test('foldCanaryStage: our own ledger recorded canary-fail -> returns the recorded stalled stage', () => {
  const canaryLedger = [
    { event: 'card-filed', date: YESTERDAY, taskId: '905', ts: at(20) },
    { event: 'canary-fail', date: YESTERDAY, taskId: '905', stage: 'dispatched', ts: at(1) },
  ];
  const r = foldCanaryStage({ dateStr: YESTERDAY, canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: [] });
  assert.equal(r.stage, 'dispatched');
});

// ── assessCanaryRow: the actual health-check row ────────────────────────────

test('assessCanaryRow: no history at all -> warn (never pass, never error on day one)', () => {
  const r = assessCanaryRow({ canaryLedgerEntries: [], dispatchLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'warn');
});

test('assessCanaryRow: null ledger (unreadable in this environment) -> warn, distinct message', () => {
  const r = assessCanaryRow({ canaryLedgerEntries: null, dispatchLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /Cannot measure/);
});

test('assessCanaryRow: yesterday verified-pass -> pass', () => {
  const canaryLedger = [
    { event: 'card-filed', date: YESTERDAY, taskId: '910', ts: at(20) },
    { event: 'canary-pass', date: YESTERDAY, taskId: '910', ts: at(1) },
  ];
  const r = assessCanaryRow({ canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'pass');
  assert.match(r.message, new RegExp(YESTERDAY));
});

test('REGRESSION: a stalled canary yields the ERROR row with the correct stage name', () => {
  // Filed yesterday, dispatched, never reached job-done — the exact shape a
  // dead runner (2026-08-10 incident) would leave behind.
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '911', ts: at(20) }];
  const shared = [{ event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '911', jobId: 'job-11', ts: at(19) }];
  const r = assessCanaryRow({ canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: shared, now: new Date(NOW) });
  assert.equal(r.status, 'error');
  assert.match(r.message, /FAILED at stage "dispatched"/);
  assert.match(r.message, new RegExp(YESTERDAY));
});

test('assessCanaryRow: yesterday never filed at all (digest itself skipped it) -> ERROR at stage "not-filed"', () => {
  // History exists from an earlier day, but nothing for yesterday specifically.
  const canaryLedger = [
    { event: 'card-filed', date: '2026-08-08', taskId: '1', ts: at(72) },
    { event: 'canary-pass', date: '2026-08-08', taskId: '1', ts: at(70) },
  ];
  const r = assessCanaryRow({ canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'error');
  assert.match(r.message, /FAILED at stage "not-filed"/);
});

test('REGRESSION: yesterday reached job-done but was never resolved (no canary-pass/fail recorded) -> WARN, not ERROR', () => {
  // The job genuinely finished — runAutofixCanary's own resolution step just
  // never got to record a verdict (e.g. a persistent local git-fetch or
  // task-load failure on this machine). Treating this as a confirmed
  // pipeline FAILURE would be a false alarm over local infra trouble, not
  // the dispatch pipeline itself.
  const canaryLedger = [{ event: 'card-filed', date: YESTERDAY, taskId: '920', ts: at(20) }];
  const shared = [
    { event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '920', jobId: 'job-20', ts: at(19) },
    { event: dispatchLedger.JOB_EVENTS.DONE, taskId: '920', jobId: 'job-20', ts: at(18) },
  ];
  const r = assessCanaryRow({ canaryLedgerEntries: canaryLedger, dispatchLedgerEntries: shared, now: new Date(NOW) });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /not yet confirmed/);
});

// ── assessThroughputRow: dispatched/passed/net with teeth ──────────────────

function entriesForDaysAgo(event, daysAgoList) {
  return daysAgoList.map((d) => ({ event, ts: new Date(NOW - d * 24 * 3600 * 1000 - 3600 * 1000).toISOString() }));
}

test('assessThroughputRow: healthy activity every day -> pass', () => {
  const digest = [...entriesForDaysAgo('auto-dispatch', [0, 1, 2, 3]), ...entriesForDaysAgo('card-pass', [0, 1, 2])];
  const r = assessThroughputRow({ digestLedgerEntries: digest, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'pass');
});

test(`REGRESSION: throughput goes ERROR on ${ZERO_DISPATCH_ERROR_DAYS} consecutive zero-dispatch days`, () => {
  // Dispatches 3-6 days ago, but NOTHING in the last 2 days — the exact
  // 8/5-8/9 starvation shape.
  const digest = entriesForDaysAgo('auto-dispatch', [3, 4, 5, 6]);
  const r = assessThroughputRow({ digestLedgerEntries: digest, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'error');
  assert.match(r.message, /DEAD: 0 dispatches/);
});

test(`assessThroughputRow: ERROR on ${ZERO_PASS_ERROR_DAYS} consecutive zero-pass days even with dispatches launching`, () => {
  const digest = entriesForDaysAgo('auto-dispatch', [0, 1, 2, 3, 4, 5]); // dispatching every day
  const r = assessThroughputRow({ digestLedgerEntries: digest, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'error');
  assert.match(r.message, /DEAD: 0 passes/);
});

test('REGRESSION: both ledgers missing (null) is NEVER scored pass — closes the #1221 class', () => {
  const r = assessThroughputRow({ digestLedgerEntries: null, backlogLedgerEntries: null, now: new Date(NOW) });
  assert.notEqual(r.status, 'pass');
  assert.equal(r.status, 'warn');
  assert.match(r.message, /not measurable/);
});

test('REGRESSION: one ledger readable + healthy but the other null (unreadable) is capped at warn, never pass — partial visibility must not read as confirmed health', () => {
  const digest = [...entriesForDaysAgo('auto-dispatch', [0, 1, 2]), ...entriesForDaysAgo('card-pass', [0, 1])];
  const r = assessThroughputRow({ digestLedgerEntries: digest, backlogLedgerEntries: null, now: new Date(NOW) });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /backlog-drain ledger unreadable/);
});

test('assessThroughputRow: backlog-drain activity alone (digest-autofix quiet) still counts toward the total', () => {
  const backlog = [...entriesForDaysAgo('drain-dispatch', [0, 1]), ...entriesForDaysAgo('card-pass', [0])];
  const r = assessThroughputRow({ digestLedgerEntries: [], backlogLedgerEntries: backlog, now: new Date(NOW) });
  assert.equal(r.status, 'pass');
  assert.match(r.message, /2 dispatched, 1 passed/);
});

test('assessThroughputRow: survives junk input without throwing', () => {
  for (const bad of ['nope', 42, {}]) {
    assert.doesNotThrow(() => assessThroughputRow({ digestLedgerEntries: bad, backlogLedgerEntries: bad, now: new Date(NOW) }));
  }
});

// REGRESSION (found chasing #1264's RECHECK, 2026-08-14): markerExistsOnOriginMain
// used to gate confirmed-absent on `err.status === 1`. Real `git cat-file -e
// <tree-ish>:<path>` exits 128 for a path missing from the tree, not 1 — so
// that branch was unreachable and a genuinely-missing marker could never
// resolve to canary-fail; it logged "could not confirm" forever. BRO-326's
// 2026-08-13 marker sat >24h past the 3h orphan window still WARNing before
// this was found. isPathAbsentFromTreeError() matches the stderr text
// instead of the exit code, so it survives git version differences either way.
test('isPathAbsentFromTreeError: real git stderr for a path missing from the tree -> true', () => {
  const err = { status: 128, stderr: Buffer.from("fatal: path 'data/audit/canary-2026-08-13.marker' does not exist in 'origin/main'\n") };
  assert.equal(isPathAbsentFromTreeError(err), true);
});

test('isPathAbsentFromTreeError: unrelated git failure (e.g. bad revision, network) -> false, not evidence of absence', () => {
  assert.equal(isPathAbsentFromTreeError({ status: 128, stderr: Buffer.from("fatal: bad revision 'origin/main'\n") }), false);
  assert.equal(isPathAbsentFromTreeError({ status: 1, stderr: Buffer.from('') }), false);
  assert.equal(isPathAbsentFromTreeError(null), false);
  assert.equal(isPathAbsentFromTreeError({}), false);
});

test('REGRESSION: isPathAbsentFromTreeError classifies the REAL `git cat-file -e` failure from this repo\'s own git binary — guards against git-version drift, not just today\'s message text', () => {
  let threw = null;
  try {
    execFileSync('git', ['cat-file', '-e', 'HEAD:this/path/definitely-does-not-exist-in-this-repo.marker'], { stdio: 'pipe' });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'expected git cat-file -e to fail for a nonexistent path');
  assert.equal(isPathAbsentFromTreeError(threw), true);
});
