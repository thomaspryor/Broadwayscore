/**
 * ack-landed-core.test.mjs — the decision behind scripts/ack-landed.js.
 * Per CLAUDE.md §15 these require() the real function; a production change
 * breaks the test, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./ack-landed-core.js');
const { JOB_EVENTS, isDeadlikeEvent, TERMINAL_JOB_EVENTS, foldJobs } = require('./dispatch-ledger.js');

const REF = 'BRO-9001';
const TASK = `linear:${REF}`;
const LAUNCH_TS = '2026-09-16T03:15:21.000Z';
const rowsStoppedShort = [
  { ts: LAUNCH_TS, event: 'launch', taskId: TASK, verifyCmd: 'node scripts/audit-workflow-concurrency.js' },
  { ts: '2026-09-16T03:15:27.000Z', event: 'job-spawned', taskId: TASK, jobId: `${TASK}-fixture` },
  { ts: '2026-09-16T04:11:36.000Z', event: 'job-stopped-short', taskId: TASK, jobId: `${TASK}-fixture`, reason: 'no THIS SESSION: status line' },
];

function happy(overrides = {}) {
  return {
    ref: REF,
    rows: rowsStoppedShort,
    landing: { verdict: 'LANDED', sha: 'c88cdf6c126fa6dc', commitTs: '2026-09-16T03:52:15.000Z', message: `${REF}: split test.yml Data Validation by intent`, descendsFromStranded: false },
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node scripts/audit-workflow-concurrency.js', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'owning session verified the split landed on origin/main',
    ackedBy: 'session-abc',
    ...overrides,
  };
}

test('happy path: stopped-short job with a landed, tied sha and a green verify → ok with a landed-acked row', () => {
  const d = core.decideAck(happy());
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.event, JOB_EVENTS.LANDED_ACKED);
  assert.equal(d.row.event, 'landed-acked');
  assert.equal(d.row.taskId, TASK);
  assert.equal(d.row.jobId, `${TASK}-fixture`);
  assert.equal(d.row.sha, 'c88cdf6c126fa6dc');
  assert.equal(d.row.verifyCmd, 'node scripts/audit-workflow-concurrency.js');
  assert.equal(d.row.ackedBy, 'session-abc');
  assert.equal(d.row.priorEvent, 'job-stopped-short');
  assert.equal(core.formatAckLine(REF, d.row), `ACKED: ${REF} — c88cdf6c126fa6dc on origin/main, node scripts/audit-workflow-concurrency.js exit 0`);
});

test('refuse: newest row is not terminal (job-spawned still open)', () => {
  const d = core.decideAck(happy({ rows: rowsStoppedShort.slice(0, 2) }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /newest ledger row is job-spawned .* not a terminal event/);
});

test('refuse: a relaunch after the stopped-short row supersedes the job you verified', () => {
  const rows = [...rowsStoppedShort, { ts: '2026-09-16T05:00:00.000Z', event: 'launch', taskId: TASK }];
  const d = core.decideAck(happy({ rows }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /newest ledger row is launch/);
});

test('refuse: newest row is job-done — nothing to ack', () => {
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T04:11:36.000Z', event: 'job-done', taskId: TASK, jobId: `${TASK}-fixture` }];
  const d = core.decideAck(happy({ rows }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /job-done — nothing to ack/);
});

test('refuse: already landed-acked (no double-ack)', () => {
  const rows = [...rowsStoppedShort, { ts: '2026-09-16T06:00:00.000Z', event: 'landed-acked', taskId: TASK, sha: 'c88cdf6c126fa6dc' }];
  const d = core.decideAck(happy({ rows }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /already landed-acked/);
});

test('refuse: no ledger rows at all', () => {
  const d = core.decideAck(happy({ rows: [] }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /no dispatch-ledger row/);
});

test('refuse: sha not on origin/main (NOT_LANDED and UNKNOWN both refuse)', () => {
  for (const verdict of ['NOT_LANDED', 'UNKNOWN']) {
    const d = core.decideAck(happy({ landing: { ...happy().landing, verdict, reason: verdict === 'UNKNOWN' ? 'unshallow-failed' : null } }));
    assert.equal(d.ok, false, verdict);
    assert.match(d.refusals.join('\n'), /not an ancestor of origin\/main/);
  }
});

test('refuse: rubber-stamp sha — committed before the launch, or not naming the ref', () => {
  const early = core.decideAck(happy({ landing: { ...happy().landing, commitTs: '2026-09-16T01:00:00.000Z' } }));
  assert.equal(early.ok, false);
  assert.match(early.refusals.join('\n'), /BEFORE this dispatch launched/);

  const unrelated = core.decideAck(happy({ landing: { ...happy().landing, message: 'chore: Record scraper-spend ledger' } }));
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.refusals.join('\n'), /commit message does not name BRO-9001/);

  // BRO-90011 must not satisfy BRO-9001 (word boundary on the ref).
  const nearMiss = core.decideAck(happy({ landing: { ...happy().landing, message: 'BRO-90011: something else' } }));
  assert.equal(nearMiss.ok, false);
});

test('stranded row: a sha descending from the recorded stranded sha is tied even without the ref in its message', () => {
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T04:11:36.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: 'deadbeef' }];
  const tied = core.decideAck(happy({ rows, landing: { ...happy().landing, message: 'merge worktree', descendsFromStranded: true } }));
  assert.equal(tied.ok, true, tied.refusals.join('\n'));
  const untied = core.decideAck(happy({ rows, landing: { ...happy().landing, message: 'merge worktree', descendsFromStranded: false } }));
  assert.equal(untied.ok, false);
  assert.match(untied.refusals.join('\n'), /nor descends from the job-stranded row's sha deadbeef/);
});

test('refuse: verify command exits 1, is unsafe, or is missing', () => {
  const red = core.decideAck(happy({ verify: { ...happy().verify, exitCode: 1 } }));
  assert.equal(red.ok, false);
  assert.match(red.refusals.join('\n'), /verify command exited 1, not 0/);

  const unsafe = core.decideAck(happy({ verify: { cmd: 'rm -rf /', safe: false, unsafeReason: 'matches none of the allowed safe-check forms', exitCode: 0 } }));
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.refusals.join('\n'), /not a safe-form command: matches none/);

  const missing = core.decideAck(happy({ verify: { cmd: '', safe: false, exitCode: null } }));
  assert.equal(missing.ok, false);
  assert.match(missing.refusals.join('\n'), /--verify is required/);
});

test('refuse: checkout does not contain the sha, or has dirty code paths', () => {
  const stale = core.decideAck(happy({ checkout: { containsSha: false, dirtyCodePaths: [] } }));
  assert.equal(stale.ok, false);
  assert.match(stale.refusals.join('\n'), /does not contain the sha yet/);
  const dirty = core.decideAck(happy({ checkout: { containsSha: true, dirtyCodePaths: ['scripts/foo.js'] } }));
  assert.equal(dirty.ok, false);
  assert.match(dirty.refusals.join('\n'), /uncommitted code changes \(scripts\/foo.js\)/);
});

test('refuse: reason shorter than 15 chars; refusals accumulate (all preconditions reported at once)', () => {
  const d = core.decideAck(happy({ reason: 'looks fine', landing: { ...happy().landing, verdict: 'NOT_LANDED' }, verify: { ...happy().verify, exitCode: 2 } }));
  assert.equal(d.ok, false);
  assert.equal(d.refusals.length, 3, d.refusals.join('\n'));
  assert.match(d.refusals.join('\n'), /--reason must be at least 15 characters \(got 10\)/);
});

test('rowsForRef matches taskId exactly or by ":REF" suffix, case-insensitively, in file order', () => {
  const entries = [
    { ts: '1', event: 'launch', taskId: 'linear:BRO-9001' },
    { ts: '2', event: 'launch', taskId: 'linear:BRO-90010' },
    { ts: '3', event: 'launch', taskId: 'BRO-9001' },
    { ts: '4', event: 'launch', taskId: 'notion:BRO-9001' },
  ];
  assert.deepEqual(core.rowsForRef(entries, 'bro-9001').map((r) => r.ts), ['1', '3', '4']);
  assert.equal(core.normalizeRef('linear:BRO-3535'), 'BRO-3535');
  assert.equal(core.normalizeRef('bro-12'), 'BRO-12');
  assert.equal(core.normalizeRef('1234'), null);
});

test('ledger contract: landed-acked is neither dead-like nor a job-state event', () => {
  assert.equal(JOB_EVENTS.LANDED_ACKED, 'landed-acked');
  assert.equal(isDeadlikeEvent('landed-acked'), false);
  assert.equal(TERMINAL_JOB_EVENTS.has('landed-acked'), false);
  // foldJobs must keep ignoring it so bsc-status/backlog-drain job views are untouched.
  const jobs = foldJobs([...rowsStoppedShort, { ts: '2026-09-16T06:00:00.000Z', event: 'landed-acked', taskId: TASK, jobId: `${TASK}-fixture` }]);
  assert.equal(jobs.get(`${TASK}-fixture`).event, 'job-stopped-short');
});
