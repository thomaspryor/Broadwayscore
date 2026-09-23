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
  assert.equal(d.row.launchVerifyCmd, 'node scripts/audit-workflow-concurrency.js');
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

test('refuse: rubber-stamp sha committed AFTER the terminal row (empty commit pushed once the job was dead)', () => {
  const late = core.decideAck(happy({ landing: { ...happy().landing, commitTs: '2026-09-16T04:30:00.000Z', message: `${REF} ack` } }));
  assert.equal(late.ok, false);
  assert.match(late.refusals.join('\n'), /AFTER the job's terminal job-stopped-short row/);
  // Inside the 5-minute skew grace it is still the job's plausible push.
  const skew = core.decideAck(happy({ landing: { ...happy().landing, commitTs: '2026-09-16T04:13:00.000Z' } }));
  assert.equal(skew.ok, true, skew.refusals.join('\n'));
});

test('stranded row: --sha must be the stranded sha (or an ancestor of it); a later landing is allowed only then', () => {
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T04:11:36.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: 'deadbeef' }];
  const tied = core.decideAck(happy({ rows, landing: { ...happy().landing, sha: 'deadbeef', commitTs: '2026-09-16T04:05:00.000Z', message: 'merge worktree', tiedToStranded: true } }));
  assert.equal(tied.ok, true, tied.refusals.join('\n'));
  assert.equal(tied.row.strandedSha, 'deadbeef');
  // A commit that merely names the ref but is not the stranded sha's history is refused.
  const untied = core.decideAck(happy({ rows, landing: { ...happy().landing, commitTs: '2026-09-16T05:00:00.000Z', tiedToStranded: false } }));
  assert.equal(untied.ok, false);
  assert.match(untied.refusals.join('\n'), /must be the stranded sha deadbeef itself, an ancestor of it, or an origin\/main commit patch-identical/);
  // Landing later than the terminal row is fine for stranded (that is the whole point of the row).
  const lateButTied = core.decideAck(happy({ rows, landing: { ...happy().landing, sha: 'deadbeef', commitTs: '2026-09-16T04:05:00.000Z', message: 'x', tiedToStranded: true } }));
  assert.equal(lateButTied.ok, true);
});

// linear:BRO-3866 (2026-09-20): stopped-short → watchdog-redispatch → the
// redispatch never produced a launch → watchdog-park. The job process is dead
// until an owner relaunches, so the park row is the terminal event an ack
// answers. The sha is checked against its AUTHOR date: the owner landed the
// dead job's branch via scripts/land.js (rebase → push), which re-stamps only
// the committer date at landing time.
const PARK_TS = '2026-09-16T04:30:00.000Z';
const rowsParked = [
  ...rowsStoppedShort,
  { ts: '2026-09-16T04:11:40.000Z', event: 'watchdog-redispatch', taskId: TASK, kind: 'p01-backlog' },
  { ts: PARK_TS, event: 'watchdog-park', taskId: TASK, reason: 'claimed at 2026-09-16T04:11:40.000Z but produced no launch — retries exhausted' },
];

test('watchdog-park newest → eligible (terminal for the dead job); row records priorEvent watchdog-park', () => {
  const d = core.decideAck(happy({ rows: rowsParked }));
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.priorEvent, 'watchdog-park');
  assert.equal(d.row.taskId, TASK);
  // jobId comes from the spawn row (the park row carries none).
  assert.equal(d.row.jobId, `${TASK}-fixture`);
  assert.equal(core.ACKABLE_TERMINAL_EVENTS.has('watchdog-park'), true);
});

test('watchdog-park then a later launch → refuse (a relaunch superseded the job you verified)', () => {
  const rows = [...rowsParked, { ts: '2026-09-16T05:00:00.000Z', event: 'launch', taskId: TASK }];
  const d = core.decideAck(happy({ rows }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /newest ledger row is launch .* not a terminal event/);
  // A pending watchdog-redispatch after the park is likewise not terminal.
  const redispatched = core.decideAck(happy({ rows: [...rowsParked, { ts: '2026-09-16T05:00:00.000Z', event: 'watchdog-redispatch', taskId: TASK }] }));
  assert.equal(redispatched.ok, false);
  assert.match(redispatched.refusals.join('\n'), /newest ledger row is watchdog-redispatch .* not a terminal event/);
});

test('watchdog-park: same sha window as the other terminal events — authored after launch, no later than park + skew', () => {
  // Authored after the park row (+5 min) — a post-mortem commit, refused.
  const late = core.decideAck(happy({ rows: rowsParked, landing: { ...happy().landing, commitTs: '2026-09-16T04:40:00.000Z', message: `${REF} ack` } }));
  assert.equal(late.ok, false);
  assert.match(late.refusals.join('\n'), /AFTER the job's terminal watchdog-park row/);
  // Authored before the launch — not this job's work.
  const early = core.decideAck(happy({ rows: rowsParked, landing: { ...happy().landing, commitTs: '2026-09-16T01:00:00.000Z' } }));
  assert.equal(early.ok, false);
  assert.match(early.refusals.join('\n'), /BEFORE this dispatch launched/);
});

test('author date is the window timestamp: a land.js rebase (late committer date, in-window author date) ties; an empty post-mortem commit does not', () => {
  const rebased = core.decideAck(happy({ rows: rowsParked, landing: { ...happy().landing, authorTs: '2026-09-16T03:52:15.000Z', commitTs: '2026-09-16T06:00:00.000Z' } }));
  assert.equal(rebased.ok, true, rebased.refusals.join('\n'));
  const postMortem = core.decideAck(happy({ rows: rowsParked, landing: { ...happy().landing, authorTs: '2026-09-16T06:00:00.000Z', commitTs: '2026-09-16T06:00:00.000Z', message: `${REF} ack` } }));
  assert.equal(postMortem.ok, false);
  assert.match(postMortem.refusals.join('\n'), /authored at 2026-09-16T06:00:00.000Z, AFTER the job's terminal watchdog-park row/);
  // Same rule for the original stopped-short shape (no authorTs → commitTs fallback still works).
  const fallback = core.decideAck(happy({ landing: { ...happy().landing, authorTs: undefined } }));
  assert.equal(fallback.ok, true, fallback.refusals.join('\n'));
});

test('ledger contract: job-abandoned is NOT dead-like, so it is deliberately not ackable', () => {
  assert.equal(JOB_EVENTS.ABANDONED, 'job-abandoned');
  assert.equal(isDeadlikeEvent('job-abandoned'), false);
  assert.equal(core.ACKABLE_TERMINAL_EVENTS.has('job-abandoned'), false);
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T03:15:30.000Z', event: 'job-abandoned', taskId: TASK, jobId: `${TASK}-fixture` }];
  const d = core.decideAck(happy({ rows }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /newest ledger row is job-abandoned .* not a terminal event/);
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

// BRO-4074: land.yml lands by REBASING, which rewrites the sha. For a stranded
// card whose work landed normally, the stranded sha is then never an ancestor
// of origin/main AND the sha that IS on main is not an ancestor of the stranded
// sha — both directions refuse, so no rebase-landed stranded job could be acked
// at all. That in turn made fanout-verified unsatisfiable for such a job, which
// is how it surfaced (BRO-4070 and BRO-4071, 2026-09-23).
//
// The rebase-aware tie is patch EQUIVALENCE: the CLI computes it with
// `git cherry` plus `git patch-id` and hands it in as tiedToStrandedByPatch. It
// compares the diff rather than the commit prose, so it is stronger evidence
// than the name check the non-stranded path relies on, not weaker.
test('BRO-4074: a stranded job whose work landed REBASED is ackable via the patch tie', () => {
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T04:11:36.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: 'deadbeef' }];
  const plan = core.decideAck(happy({ rows, landing: { ...happy().landing, sha: 'cafebabe', commitTs: '2026-09-16T05:00:00.000Z', message: 'rebased twin', tiedToStranded: false, tiedToStrandedByPatch: true } }));
  assert.equal(plan.ok, true, plan.refusals.join('\n'));
  assert.equal(plan.row.strandedSha, 'deadbeef', 'the row still records the stranded sha, not the twin');
});

test('BRO-4074: neither tie still refuses, and the refusal names the twin as an option', () => {
  const rows = [...rowsStoppedShort.slice(0, 2), { ts: '2026-09-16T04:11:36.000Z', event: 'job-stranded', taskId: TASK, jobId: `${TASK}-fixture`, sha: 'deadbeef' }];
  const plan = core.decideAck(happy({ rows, landing: { ...happy().landing, sha: 'cafebabe', commitTs: '2026-09-16T05:00:00.000Z', tiedToStranded: false, tiedToStrandedByPatch: false } }));
  assert.equal(plan.ok, false, 'the patch tie widens WHICH sha is accepted; it does not remove the requirement');
  assert.match(plan.refusals.join('\n'), /patch-identical/,
    'an operator who hits this must be told the rebase-landed twin is allowed, or they hit the same dead end');
});
