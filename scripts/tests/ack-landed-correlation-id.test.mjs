/**
 * ack-landed-correlation-id.test.mjs — BRO-4133: `--job-id` refused a
 * correlationId, so a card whose work was done by a legacy cmux dispatch
 * attempt (no jobId — only a correlationId on its own `launch` row) could
 * never be acked. Real case: linear:BRO-3471's first attempt landed
 * d275bfaef0c under correlationId e403e845 and ended prune-closed with no
 * jobId ever written; two later mistaken re-dispatches buried that attempt's
 * launch/terminal pair under their own job-* rows. rowsForJobId now falls
 * back to a correlationId match on a `launch` row when the value given
 * matches no row's jobId, scoping to that ONE attempt's window (its launch
 * row through, but excluding, the next launch/job-spawned row for this ref).
 * Per CLAUDE.md §15 this require()s the real function; a production change
 * breaks the test, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../lib/ack-landed-core.js');

const REF = 'BRO-3471';
const TASK = `linear:${REF}`;
const CORR1 = 'e403e845';
const CORR2 = '4eaf65c0';
const CORR3 = 'c466ce43';
const JOB3 = `${TASK}-muaie9ja`;

// Reproduces the real BRO-3471 ledger shape from the issue: a legacy cmux
// launch (correlationId only, no jobId) that actually did the work, then two
// later retracted re-dispatches, the last of which DOES carry a jobId.
const LAUNCH1_TS = '2026-09-16T01:14:51.000Z';
const PRUNE1_TS = '2026-09-16T02:03:54.000Z';
const LAUNCH2_TS = '2026-09-20T19:02:16.000Z';
const VANISHED2_TS = '2026-09-20T19:21:51.000Z';
const LAUNCH3_TS = '2026-09-21T00:30:40.000Z';
const SPAWNED3_TS = '2026-09-21T00:30:45.000Z';
const STOPPED3_TS = '2026-09-21T02:08:32.000Z';

const rows = [
  { ts: LAUNCH1_TS, event: 'launch', taskId: TASK, correlationId: CORR1, workspaceRef: 'workspace:501' },
  { ts: PRUNE1_TS, event: 'prune-closed', taskId: TASK, workspaceRef: 'workspace:501' },
  { ts: LAUNCH2_TS, event: 'launch', taskId: TASK, correlationId: CORR2, workspaceRef: 'workspace:502' },
  { ts: VANISHED2_TS, event: 'vanished', taskId: TASK, workspaceRef: 'workspace:502' },
  { ts: LAUNCH3_TS, event: 'launch', taskId: TASK, correlationId: CORR3, jobId: JOB3 },
  { ts: SPAWNED3_TS, event: 'job-spawned', taskId: TASK, jobId: JOB3 },
  { ts: STOPPED3_TS, event: 'job-stopped-short', taskId: TASK, jobId: JOB3, reason: 'no THIS SESSION: status line in final result' },
];

// The sha genuinely authored during attempt 1's own window (19 min after its
// launch, well before the prune-closed row), naming the card.
const ATTEMPT1_LANDING = {
  verdict: 'LANDED',
  sha: 'd275bfaef0c123',
  commitTs: '2026-09-16T01:33:34.000Z',
  message: `${REF}: audit-show-score-urls.js baseline`,
};

function base(overrides = {}) {
  return {
    ref: REF,
    rows,
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node --test scripts/lib/show-score-urls-baseline.test.mjs', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'owning session verified the first attempt landed on origin/main',
    ackedBy: 'session-abc',
    ...overrides,
  };
}

test('a correlationId on a launch row resolves to that attempt\'s window (rowsForJobId)', () => {
  const scoped = core.rowsForJobId(rows, CORR1, REF);
  assert.equal(scoped.refusal, null);
  // The window is attempt 1's launch through (excluding) attempt 2's launch —
  // i.e. just the launch + its own prune-closed row.
  assert.deepEqual(scoped.rows.map((r) => r.ts), [LAUNCH1_TS, PRUNE1_TS]);
});

test('decideAck with a correlationId as --job-id acks the legacy cmux attempt cleanly', () => {
  const d = core.decideAck(base({ jobId: CORR1, landing: ATTEMPT1_LANDING }));
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.event, 'landed-acked');
  assert.equal(d.row.taskId, TASK);
  // No jobId exists anywhere on this attempt's rows — the row must not
  // fabricate one.
  assert.equal(d.row.jobId, null);
  assert.equal(d.row.priorEvent, 'prune-closed');
});

test('without --job-id, preconditions bind to the LATEST attempt and refuse attempt 1\'s own landing', () => {
  const d = core.decideAck(base({ landing: ATTEMPT1_LANDING }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /BEFORE this dispatch launched/);
});

test('a correlationId not on this ref\'s rows is refused', () => {
  const d = core.decideAck(base({ jobId: 'deadbeef', landing: ATTEMPT1_LANDING }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /--job-id deadbeef has no ledger rows under BRO-3471/);
  assert.match(d.refusals.join('\n'), /correlationId on one of its launch rows/);
});

test('a sha authored before that attempt\'s launch is still refused even when scoped by correlationId', () => {
  const d = core.decideAck(base({
    jobId: CORR1,
    landing: { ...ATTEMPT1_LANDING, commitTs: '2026-09-15T23:00:00.000Z' },
  }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /BEFORE this dispatch launched/);
});

test('a jobId match still wins over a correlationId fallback (attempt 3, unaffected by this fix)', () => {
  const attempt3Landing = { verdict: 'LANDED', sha: 'cafef00dbeef456', commitTs: '2026-09-21T01:00:00.000Z', message: `${REF}: re-verify` };
  const d = core.decideAck(base({ jobId: JOB3, landing: attempt3Landing }));
  assert.equal(d.ok, true, d.refusals.join('\n'));
  assert.equal(d.row.jobId, JOB3);
});

// Adversarial review (Codex + a subagent) found that a first version of this
// fix bounded a correlationId match positionally ("up to the next launch or
// job-spawned row"), which broke two real shapes:

test('adjacency: attempt A\'s terminal row arriving AFTER attempt B\'s launch is still found via workspaceRef, not misattributed to B', () => {
  const corrA = 'aaaa1111';
  const corrB = 'bbbb2222';
  const launchA = '2026-09-16T01:00:00.000Z';
  const launchB = '2026-09-16T02:00:00.000Z';
  const terminalA = '2026-09-16T03:00:00.000Z'; // AFTER B's launch — delayed/out-of-order
  const outOfOrderRows = [
    { ts: launchA, event: 'launch', taskId: TASK, correlationId: corrA, workspaceRef: 'workspace:601' },
    { ts: launchB, event: 'launch', taskId: TASK, correlationId: corrB, workspaceRef: 'workspace:602' },
    { ts: terminalA, event: 'prune-closed', taskId: TASK, workspaceRef: 'workspace:601' },
  ];
  const scoped = core.rowsForJobId(outOfOrderRows, corrA, REF);
  assert.equal(scoped.refusal, null);
  // A's own launch + its own (delayed) terminal row, NOT B's launch.
  assert.deepEqual(scoped.rows.map((r) => r.ts), [launchA, terminalA]);
});

test('a headless launch matched by correlationId still reaches its own job-spawned/terminal rows (job-spawned is not a window boundary)', () => {
  const corrH = 'headless99';
  const hLaunchTs = '2026-09-21T00:30:40.000Z';
  const hSpawnedTs = '2026-09-21T00:30:45.000Z';
  const hStoppedTs = '2026-09-21T02:08:32.000Z';
  const headlessRows = [
    { ts: hLaunchTs, event: 'launch', taskId: TASK, correlationId: corrH, workspaceRef: 'headless:linear:BRO-3471' },
    { ts: hSpawnedTs, event: 'job-spawned', taskId: TASK, jobId: 'linear:BRO-3471-someid' },
    { ts: hStoppedTs, event: 'job-stopped-short', taskId: TASK, jobId: 'linear:BRO-3471-someid' },
  ];
  const scoped = core.rowsForJobId(headlessRows, corrH, REF);
  assert.equal(scoped.refusal, null);
  assert.deepEqual(scoped.rows.map((r) => r.ts), [hLaunchTs, hSpawnedTs, hStoppedTs]);
});

test('idempotency: a landed-acked row from a correlationId-scoped ack carries the launch\'s workspaceRef, so a re-ack attempt refuses (do not double-ack)', () => {
  const first = core.decideAck(base({ jobId: CORR1, landing: ATTEMPT1_LANDING }));
  assert.equal(first.ok, true, first.refusals.join('\n'));
  assert.equal(first.row.workspaceRef, 'workspace:501');

  const rowsAfterAck = [...rows, { ...first.row, ts: '2026-09-24T12:00:00.000Z' }];
  const second = core.decideAck(base({ rows: rowsAfterAck, jobId: CORR1, landing: ATTEMPT1_LANDING }));
  assert.equal(second.ok, false);
  assert.match(second.refusals.join('\n'), /already landed-acked.*do not double-ack/);
});
