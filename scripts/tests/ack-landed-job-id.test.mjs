/**
 * ack-landed-job-id.test.mjs — BRO-4066: ack-landed.js used to evaluate every
 * precondition against the ref's LATEST ledger row, which breaks the moment
 * a card is re-dispatched after an EARLIER attempt had already landed. Real
 * case: linear:BRO-3924's first job (linear:BRO-3924-muaj8awa) landed
 * 8df620cc09d then ended job-stopped-short only for a missing status line; a
 * --force re-dispatch (linear:BRO-3924-mudixhyq) verified the landing and
 * moved the card Done, wrote no commit of its own, and ALSO ended
 * job-stopped-short — leaving no row whose "newest" was the first job's own
 * landing. --job-id scopes decideAck to one dispatch attempt instead of the
 * ref's latest. Per CLAUDE.md §15 this require()s the real function; a
 * production change breaks the test, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../lib/ack-landed-core.js');

const REF = 'BRO-9002';
const TASK = `linear:${REF}`;
const JOB1 = `${TASK}-muaj8awa`;
const JOB2 = `${TASK}-mudixhyq`;

// Attempt 1: spawned, landed its own work, then stopped-short only for the
// missing THIS SESSION: line (the BRO-3924 shape).
const SPAWN1_TS = '2026-09-21T00:54:30.000Z';
const STOP1_TS = '2026-09-21T01:35:00.000Z';
// Attempt 2: a later --force redispatch of the SAME card that never wrote a
// commit of its own (it only re-verified attempt 1's landing) and also ended
// stopped-short.
const SPAWN2_TS = '2026-09-23T03:09:00.000Z';
const STOP2_TS = '2026-09-23T03:20:00.000Z';

const rows = [
  { ts: SPAWN1_TS, event: 'job-spawned', taskId: TASK, jobId: JOB1, cwd: '/tmp/job1' },
  { ts: STOP1_TS, event: 'job-stopped-short', taskId: TASK, jobId: JOB1, reason: 'no THIS SESSION: status line in final result' },
  { ts: SPAWN2_TS, event: 'job-spawned', taskId: TASK, jobId: JOB2, cwd: '/tmp/job2' },
  { ts: STOP2_TS, event: 'job-stopped-short', taskId: TASK, jobId: JOB2, reason: 'no THIS SESSION: status line in final result' },
];

// A sha genuinely authored during attempt 1's own window, naming the ref.
const ATTEMPT1_LANDING = {
  verdict: 'LANDED',
  sha: '8df620cc09dabc123',
  commitTs: '2026-09-21T01:29:00.000Z',
  message: `${REF}: land the fix`,
};

function base(overrides = {}) {
  return {
    ref: REF,
    rows,
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node scripts/audit-workflow-concurrency.js', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'owning session verified the earlier attempt landed on origin/main',
    ackedBy: 'session-abc',
    ...overrides,
  };
}

test('without --job-id, preconditions bind to the LATEST attempt — an earlier attempt\'s own landing is refused (reproduces BRO-3924)', () => {
  const d = core.decideAck(base({ landing: ATTEMPT1_LANDING }));
  assert.equal(d.ok, false);
  // Compared against attempt 2's launch (SPAWN2_TS), attempt 1's sha reads as
  // committed before the dispatch even started.
  assert.match(d.refusals.join('\n'), /BEFORE this dispatch launched/);
});

test('--job-id scopes every precondition to that ONE attempt: attempt 1\'s own landing now acks cleanly', () => {
  const d = core.decideAck(base({ jobId: JOB1, landing: ATTEMPT1_LANDING }));
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.event, 'landed-acked');
  assert.equal(d.row.taskId, TASK);
  assert.equal(d.row.jobId, JOB1);
  assert.equal(d.row.priorEvent, 'job-stopped-short');
  assert.equal(core.formatAckLine(REF, d.row), `ACKED: ${REF} — 8df620cc09dabc123 on origin/main, node scripts/audit-workflow-concurrency.js exit 0`);
});

test('--job-id still enforces the SCOPED attempt\'s own window: a sha from attempt 1 authored after attempt 2\'s later terminal row is not "attempt 1\'s window" but IS still after attempt 1\'s own terminal row + skew, so it refuses', () => {
  const late = core.decideAck(base({
    jobId: JOB1,
    landing: { ...ATTEMPT1_LANDING, commitTs: '2026-09-23T04:00:00.000Z' },
  }));
  assert.equal(late.ok, false);
  assert.match(late.refusals.join('\n'), /AFTER the job's terminal job-stopped-short row/);
});

test('--job-id for the LATEST attempt behaves like the default (both resolve to attempt 2)', () => {
  const attempt2Landing = { verdict: 'LANDED', sha: 'cafef00dbeef456', commitTs: '2026-09-23T03:15:00.000Z', message: `${REF}: re-verify` };
  const withJobId = core.decideAck(base({ jobId: JOB2, landing: attempt2Landing }));
  const withoutJobId = core.decideAck(base({ landing: attempt2Landing }));
  assert.equal(withJobId.ok, true, withJobId.refusals.join('\n'));
  assert.equal(withoutJobId.ok, true, withoutJobId.refusals.join('\n'));
  assert.equal(withJobId.row.jobId, JOB2);
  assert.equal(withoutJobId.row.jobId, JOB2);
});

test('refuse: --job-id that does not belong to this ref\'s own dispatch history', () => {
  const d = core.decideAck(base({ jobId: 'linear:BRO-1234-someoneelse', landing: ATTEMPT1_LANDING }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /--job-id linear:BRO-1234-someoneelse has no ledger rows under BRO-9002/);
});

test('rowsForJobId: no jobId is a no-op (returns all rows, unchanged behavior)', () => {
  const scoped = core.rowsForJobId(rows, null, REF);
  assert.equal(scoped.refusal, null);
  assert.deepEqual(scoped.rows, rows);
});

test('rowsForJobId: scopes to exactly the matching jobId\'s rows, in file order', () => {
  const scoped = core.rowsForJobId(rows, JOB1, REF);
  assert.equal(scoped.refusal, null);
  assert.deepEqual(scoped.rows.map((r) => r.ts), [SPAWN1_TS, STOP1_TS]);
});
