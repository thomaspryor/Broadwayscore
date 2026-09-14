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
const { isAutofixFiledTitle } = require('./autofix-filed-marker.js');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

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

// BRO-2499: the canary card is titled "CANARY: touch ..." and carries
// digest-autofix's PARKED provenance, so linear-dispatch.js's
// autofixFiledIssueGuard refuses it at `linear-next.js --id` unless this
// module passes the opt-in. runAutofixCanary() does real filing/spawning I/O
// with no dispatch seam, so this is a source-level pin instead: EVERY
// dispatchDetached call site here must carry the waiver. Without it the daily
// end-to-end canary silently stops dispatching and only self-reports ~24h
// later, as the very starvation this module exists to detect.
test('every dispatchDetached call site passes allowAutofixFiled (BRO-2499)', () => {
  const src = readFileSync(new URL('./autofix-canary.js', import.meta.url), 'utf8');
  const calls = src.match(/dispatchDetached\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, `expected at least 2 dispatchDetached call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /allowAutofixFiled:\s*true/, `dispatchDetached call site missing the BRO-2499 waiver: ${call}`);
  }
});

// BRO-3060: fileCard's --park ALSO means every canary card carries
// headless-dispatchability.js's PARKED_SENTINEL — a second, independent
// guard the allowAutofixFiled waiver above does not cover. Discovered live
// 2026-09-08: the canary was dispatching itself into a guaranteed refusal
// every day. Same source-level pin as the test above, for the same reason.
test('every dispatchDetached call site passes allowAutomationParked (BRO-3060)', () => {
  const src = readFileSync(new URL('./autofix-canary.js', import.meta.url), 'utf8');
  const calls = src.match(/dispatchDetached\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, `expected at least 2 dispatchDetached call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /allowAutomationParked:\s*true/, `dispatchDetached call site missing the BRO-3060 waiver: ${call}`);
  }
});

test('canaryCardTitle is exactly the shape autofixFiledIssueGuard recognises (BRO-2499)', () => {
  // Cross-module pin: if canaryCardTitle's prefix is ever changed, the guard
  // stops recognising the canary and a crown-loop sweep can pick it up.
  assert.equal(isAutofixFiledTitle(canaryCardTitle(TODAY)), true);
});

// ── BRO-3321: outcomes are bucketed by the day their DISPATCH ran ────────────

test('assessThroughputRow: a late-reconciled pass is credited to its dispatch day, not the write day', () => {
  // The 2026-09-14 shape: reconciliation ran long after the dispatch. Crediting
  // the pass to the write day moves it to a day the work did not happen on —
  // and, when the lag exceeds the window, into a day that is not in it at all.
  // 10 days back: OUTSIDE the 7-day throughput window. This is what makes the
  // test discriminate — under write-time bucketing the pass lands on today and
  // counts; under dispatch-time bucketing it is correctly out of window. A
  // 3-day offset would have been inside the window either way and proved
  // nothing.
  const dispatchDay = new Date(NOW - 10 * 86400000).toISOString();
  const rows = [
    { event: 'auto-dispatch', ts: dispatchDay },
    { event: 'card-pass', ts: new Date(NOW).toISOString(), judgedDispatchTs: dispatchDay },
    // Keep the zero-DISPATCH arm quiet so this test measures only where the
    // pass was bucketed — that arm fires first and would mask the assertion.
    { event: 'auto-dispatch', ts: new Date(NOW).toISOString() },
    { event: 'auto-dispatch', ts: new Date(NOW - 86400000).toISOString() },
  ];
  const r = assessThroughputRow({ digestLedgerEntries: rows, backlogLedgerEntries: [], now: new Date(NOW) });
  // Aged to its 10-day-old dispatch, the pass is outside the 7d window, so the
  // window genuinely holds zero passes and the zero-pass arm fires. That arm
  // firing IS the observable difference between the two clocks.
  assert.equal(r.status, 'error', `got ${JSON.stringify(r)}`);
  assert.match(r.message, /0 passes/, `got ${JSON.stringify(r)}`);

  // Control: the SAME rows without judgedDispatchTs fall back to write time,
  // land the pass on today, and do NOT alarm — proving the field, and not some
  // other difference in the fixture, is what moved it.
  const unstamped = rows.map((e) => { const { judgedDispatchTs, ...rest } = e; return rest; });
  const c = assessThroughputRow({ digestLedgerEntries: unstamped, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.notEqual(c.status, 'error', `control: got ${JSON.stringify(c)}`);
  assert.match(c.message, /2 dispatched, 1 passed/, `control: got ${JSON.stringify(c)}`);
});

test("assessThroughputRow: today's empty bucket never starts a zero-pass streak on its own", () => {
  // Today is unobserved, not zero: reconciliation for today's dispatches has
  // not run yet. Counting it added a permanent +1 and turned
  // ZERO_PASS_ERROR_DAYS = 3 into an effective 2.
  const day = (n) => new Date(NOW - n * 86400000).toISOString();
  const rows = [
    { event: 'auto-dispatch', ts: day(0) },
    { event: 'auto-dispatch', ts: day(1) },
    { event: 'card-pass', ts: day(1), judgedDispatchTs: day(1) },
    { event: 'auto-dispatch', ts: day(2) },
    { event: 'card-pass', ts: day(2), judgedDispatchTs: day(2) },
  ];
  const r = assessThroughputRow({ digestLedgerEntries: rows, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.notEqual(r.status, 'error', `two of the last three days landed passes; got ${JSON.stringify(r)}`);
});

test('assessThroughputRow: a genuine zero-pass run of 3 real days still errors', () => {
  // The grace must delay the alarm by the unobserved day, not disable it.
  const day = (n) => new Date(NOW - n * 86400000).toISOString();
  const rows = [1, 2, 3, 4].map((n) => ({ event: 'auto-dispatch', ts: day(n) }));
  const r = assessThroughputRow({ digestLedgerEntries: rows, backlogLedgerEntries: [], now: new Date(NOW) });
  assert.equal(r.status, 'error', `dispatching daily and landing nothing IS dead; got ${JSON.stringify(r)}`);
  assert.match(r.message, /0 passes/);
});

// ── BRO-3321 follow-up: the zero-dispatch banner's gate ─────────────────────
// This decides whether the owner gets a red "DEAD" banner. It was a bare
// conditional inside send-morning-digest.js — a file that reads disk and sends
// mail, so it could not be tested at all. Extracted and pinned here.

const DEAD_DISPATCH = { status: 'error', message: 'Autofix throughput DEAD: 0 dispatches on each of the last 3 day(s) — this is the exact 8/5-8/9 starvation shape (task #1184).' };
const DEAD_PASS = { status: 'error', message: 'Autofix throughput DEAD: 0 passes on each of the last 3 day(s) — dispatches are launching but nothing is landing.' };
const HEALTHY = { status: 'pass', message: 'Autofix throughput over the last 7d: 9 dispatched, 8 passed (net 1).' };

test('throughputDeathMessage: surfaces the zero-DISPATCH death only when work is queued', () => {
  const { throughputDeathMessage } = require('./autofix-canary.js');
  assert.equal(
    throughputDeathMessage(DEAD_DISPATCH, { pendingIssues: 42 }),
    DEAD_DISPATCH.message,
    'issues queued and nothing dispatching IS the dead shape'
  );
});

test('throughputDeathMessage: an idle fleet with an empty queue is HEALTHY, not dead', () => {
  const { throughputDeathMessage } = require('./autofix-canary.js');
  // ZERO_DISPATCH_ERROR_DAYS is 2, so without this guard two quiet days — a
  // fleet with nothing to fix — would email the owner "Autofix throughput DEAD".
  assert.equal(throughputDeathMessage(DEAD_DISPATCH, { pendingIssues: 0 }), null);
  assert.equal(throughputDeathMessage(DEAD_DISPATCH, {}), null, 'defaults to quiet, not to alarming');
});

test('throughputDeathMessage: never double-fires the zero-PASS arm', () => {
  const { throughputDeathMessage } = require('./autofix-canary.js');
  // assessAutofixEffectiveness already answers "dispatching but not landing".
  // Surfacing it here too would render one condition as two red banners.
  assert.equal(throughputDeathMessage(DEAD_PASS, { pendingIssues: 42 }), null);
});

test('throughputDeathMessage: stays quiet on healthy, warn, and junk input', () => {
  const { throughputDeathMessage } = require('./autofix-canary.js');
  assert.equal(throughputDeathMessage(HEALTHY, { pendingIssues: 42 }), null);
  assert.equal(throughputDeathMessage({ status: 'warn', message: '0 dispatches ...' }, { pendingIssues: 42 }), null,
    'warn is "not measurable here", not a death — it must never become a DEAD banner');
  for (const junk of [null, undefined, {}, { status: 'error' }, { status: 'error', message: 42 }]) {
    assert.equal(throughputDeathMessage(junk, { pendingIssues: 42 }), null, `junk input must not throw or alarm: ${JSON.stringify(junk)}`);
  }
});

test('assessThroughputRow: an unparseable ts never throws — one bad row must not kill the digest', () => {
  // REGRESSION (BRO-3321 follow-up). canaryDateStr does new Date(ts).toISOString(),
  // which throws RangeError on a truthy-but-unparseable ts. dailyCounts only
  // guarded `if (!ts)`. Once this row was wired into send-morning-digest.js's
  // localLoopDeadMessage, that throw escaped buildHtml and the owner's morning
  // digest would simply never send — one malformed ledger row becoming a silent
  // daily outage. The ledger explicitly models this shape existing
  // (autofix-effectiveness.js's undatedNote: "unreadable timestamps — writer bug").
  const { assessThroughputRow } = require('./autofix-canary.js');
  for (const bad of ['not-a-date', '   ', '2026-13-45T99:99:99Z', 'null', '0000']) {
    assert.doesNotThrow(
      () => assessThroughputRow({
        digestLedgerEntries: [{ event: 'card-pass', ts: bad }],
        backlogLedgerEntries: [{ event: 'drain-dispatch', ts: bad }],
        now: new Date(NOW),
      }),
      `ts ${JSON.stringify(bad)} must be skipped, not thrown on`
    );
  }
});

test('assessThroughputRow: a bad row is skipped, and the GOOD rows around it still count', () => {
  // Skipping must not mean discarding the whole report.
  const { assessThroughputRow } = require('./autofix-canary.js');
  const good = new Date(NOW - 86400000).toISOString();
  const r = assessThroughputRow({
    digestLedgerEntries: [
      { event: 'auto-dispatch', ts: 'not-a-date' },
      { event: 'auto-dispatch', ts: good },
      { event: 'card-pass', ts: good, judgedDispatchTs: good },
      { event: 'auto-dispatch', ts: new Date(NOW).toISOString() },
    ],
    backlogLedgerEntries: [],
    now: new Date(NOW),
  });
  assert.match(r.message, /2 dispatched, 1 passed/, `the readable rows must still be counted; got ${JSON.stringify(r)}`);
});
