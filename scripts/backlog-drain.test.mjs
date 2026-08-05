import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMyJob, reconcileOutcomes, ORPHAN_TIMEOUT_H } = require('./backlog-drain.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');

// ── findMyJob: correlates by job-spawned ts, not "latest job for taskId" ───
// (ship-check adversarial finding: dispatch-ledger.foldJobs's last-event-wins
// merge overwrites `ts` with the TERMINAL event's time, so picking "the job
// with the latest ts" can silently grab a manual dispatch's job instead of
// the one this drain-dispatch actually caused.)

test('findMyJob picks the job spawned AT/AFTER the dispatch ts, not an earlier or unrelated one', () => {
  const entries = [
    // An OLDER, already-finished job for the same task (e.g. a prior drain
    // attempt, or a manual run before this drain-dispatch) — must be ignored.
    { ts: '2026-07-30T10:00:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-old' },
    { ts: '2026-07-30T10:05:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '4', jobId: '4-old', costUSD: 1 },
    // THIS drain-dispatch fires at 11:00; its job spawns a moment later.
    { ts: '2026-07-30T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-mine' },
  ];
  const job = findMyJob(entries, '4', '2026-07-30T11:00:00Z');
  assert.ok(job, 'expected to find the job spawned after the dispatch ts');
  assert.equal(job.jobId, '4-mine');
});

test('findMyJob returns null when no job-spawned event exists at/after the dispatch ts', () => {
  const entries = [
    { ts: '2026-07-30T09:00:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-old' },
  ];
  assert.equal(findMyJob(entries, '4', '2026-07-30T11:00:00Z'), null);
});

test('findMyJob picks the EARLIEST qualifying spawn when multiple exist after the dispatch ts', () => {
  const entries = [
    { ts: '2026-07-30T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-first' },
    { ts: '2026-07-30T11:30:00Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-second' },
  ];
  const job = findMyJob(entries, '4', '2026-07-30T11:00:00Z');
  assert.equal(job.jobId, '4-first');
});

// ── reconcileOutcomes ───────────────────────────────────────────────────────

test('reconcileOutcomes: pass requires BOTH job-done AND the task marked completed', () => {
  const dispatchEntries = [
    { ts: '2026-07-30T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-mine' },
    { ts: '2026-07-30T11:10:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '4', jobId: '4-mine', costUSD: 0.5 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-07-30T11:00:00Z', event: 'drain-dispatch', taskId: '4', subject: 'x', contentHash: 'abc' },
  ];
  const tasksById = new Map([['4', { id: '4', status: 'completed' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries, new Date('2026-07-30T11:15:00Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'card-pass');
  assert.equal(out[0].usd, 0.5);
});

test('reconcileOutcomes: job-done but task still pending counts as a fail (burned money, nothing shipped)', () => {
  const dispatchEntries = [
    { ts: '2026-07-30T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-mine' },
    { ts: '2026-07-30T11:10:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '4', jobId: '4-mine', costUSD: 0.5 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-07-30T11:00:00Z', event: 'drain-dispatch', taskId: '4', subject: 'x', contentHash: 'abc' },
  ];
  const tasksById = new Map([['4', { id: '4', status: 'pending' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries, new Date('2026-07-30T11:15:00Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'card-fail');
});

test('reconcileOutcomes: no job-spawned within ORPHAN_TIMEOUT_H resolves to card-fail (refused-but-announced case)', () => {
  const dispatchEntries = []; // spawn never observed
  const drainLedgerEntries = [
    { ts: '2026-07-30T11:00:00Z', event: 'drain-dispatch', taskId: '4', subject: 'x', contentHash: 'abc' },
  ];
  const tasksById = new Map([['4', { id: '4', status: 'pending' }]]);
  const tooSoon = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date(new Date('2026-07-30T11:00:00Z').getTime() + (ORPHAN_TIMEOUT_H - 1) * 3600e3));
  assert.equal(tooSoon.length, 0, 'must not resolve before the orphan timeout elapses');

  const afterTimeout = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date(new Date('2026-07-30T11:00:00Z').getTime() + (ORPHAN_TIMEOUT_H + 1) * 3600e3));
  assert.equal(afterTimeout.length, 1);
  assert.equal(afterTimeout[0].event, 'card-fail');
  assert.match(afterTimeout[0].note, /spawn never observed/);
});

test('reconcileOutcomes: skips a taskId already resolved (idempotent across ticks)', () => {
  const dispatchEntries = [
    { ts: '2026-07-30T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '4', jobId: '4-mine' },
    { ts: '2026-07-30T11:10:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '4', jobId: '4-mine', costUSD: 0.5 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-07-30T11:00:00Z', event: 'drain-dispatch', taskId: '4', subject: 'x', contentHash: 'abc' },
    { ts: '2026-07-30T11:20:00Z', event: 'card-pass', cardId: '4', contentHash: 'abc', usd: 0.5 },
  ];
  const tasksById = new Map([['4', { id: '4', status: 'completed' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries, new Date('2026-07-30T11:30:00Z'));
  assert.equal(out.length, 0);
});

// ── card-stranded (task #1004) ──────────────────────────────────────────────
// 2026-08-04: two of four drain sessions did all the work, hit a gate only the
// owner could clear, and were scored card-fail. The ledger then read "$14.74,
// zero completions", which sent the next session hunting a red trunk that did
// not exist. A finished session that left commits on its job branch is now
// recorded as its own outcome, so the money and the diagnosis stay honest.

test('reconcileOutcomes: job-done + card open + commits on the job branch is card-stranded, not card-fail', () => {
  const dispatchEntries = [
    { ts: '2026-08-04T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '30', jobId: '30-msdaql3v' },
    { ts: '2026-08-04T11:40:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '30', jobId: '30-msdaql3v', costUSD: 9.34 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-08-04T11:00:00Z', event: 'drain-dispatch', taskId: '30', subject: 'Rage clicks', contentHash: 'abc' },
  ];
  const tasksById = new Map([['30', { id: '30', status: 'in_progress' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date('2026-08-04T12:00:00Z'), { strandedCommits: () => 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'card-stranded');
  assert.equal(out[0].usd, 9.34);
  assert.equal(out[0].strandedCommits, 2);
  assert.equal(out[0].strandedBranch, 'job/30-msdaql3v');
  assert.match(out[0].note, /blocked at the landing gate/);
});

test('reconcileOutcomes: a finished session with NO commits is still a plain card-fail', () => {
  const dispatchEntries = [
    { ts: '2026-08-04T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '31', jobId: '31-x' },
    { ts: '2026-08-04T11:40:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '31', jobId: '31-x', costUSD: 1.2 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-08-04T11:00:00Z', event: 'drain-dispatch', taskId: '31', subject: 'x', contentHash: 'abc' },
  ];
  const tasksById = new Map([['31', { id: '31', status: 'pending' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date('2026-08-04T12:00:00Z'), { strandedCommits: () => 0 });
  assert.equal(out[0].event, 'card-fail');
  assert.equal(out[0].strandedCommits, undefined);
});

test('reconcileOutcomes: a card already resolved as card-stranded is not re-reconciled', () => {
  const dispatchEntries = [
    { ts: '2026-08-04T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '30', jobId: '30-msdaql3v' },
    { ts: '2026-08-04T11:40:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '30', jobId: '30-msdaql3v', costUSD: 9.34 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-08-04T11:00:00Z', event: 'drain-dispatch', taskId: '30', subject: 'x', contentHash: 'abc' },
    { ts: '2026-08-04T12:00:00Z', event: 'card-stranded', cardId: '30', contentHash: 'abc', usd: 9.34 },
  ];
  const tasksById = new Map([['30', { id: '30', status: 'in_progress' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date('2026-08-04T13:00:00Z'), { strandedCommits: () => 2 });
  assert.equal(out.length, 0);
});

// ── re-dispatch accounting (ship-check, Codex 2026-08-04) ───────────────────
// An outcome resolves the dispatch it FOLLOWS, not the card forever. The old
// card-id Set meant a second dispatch of the same card produced no outcome at
// all — no spend accounting, no attempt memory, no retry ceiling.

test('reconcileOutcomes: a SECOND dispatch after an earlier outcome still reconciles', () => {
  const dispatchEntries = [
    { ts: '2026-08-04T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '7', jobId: '7-a' },
    { ts: '2026-08-04T11:30:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '7', jobId: '7-a', costUSD: 2 },
    { ts: '2026-08-04T15:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '7', jobId: '7-b' },
    { ts: '2026-08-04T15:30:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '7', jobId: '7-b', costUSD: 3 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-08-04T11:00:00Z', event: 'drain-dispatch', taskId: '7', subject: 'x', contentHash: 'h1' },
    { ts: '2026-08-04T11:35:00Z', event: 'card-fail', cardId: '7', contentHash: 'h1', usd: 2 },
    // owner edited the card, it re-entered the pool, drain dispatched again
    { ts: '2026-08-04T15:00:00Z', event: 'drain-dispatch', taskId: '7', subject: 'x', contentHash: 'h2' },
  ];
  const tasksById = new Map([['7', { id: '7', status: 'completed' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date('2026-08-04T16:00:00Z'), { strandedCommits: () => 0 });
  assert.equal(out.length, 1, 'the second dispatch must produce its own outcome');
  assert.equal(out[0].event, 'card-pass');
  assert.equal(out[0].usd, 3);
  assert.equal(out[0].contentHash, 'h2');
});

test('reconcileOutcomes: two unresolved dispatches of the same card in one tick emit one outcome each, not one total', () => {
  const dispatchEntries = [
    { ts: '2026-08-04T11:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '8', jobId: '8-a' },
    { ts: '2026-08-04T11:30:00Z', event: dispatchLedger.JOB_EVENTS.DONE, taskId: '8', jobId: '8-a', costUSD: 1 },
  ];
  const drainLedgerEntries = [
    { ts: '2026-08-04T11:00:00Z', event: 'drain-dispatch', taskId: '8', subject: 'x', contentHash: 'h1' },
    { ts: '2026-08-04T11:00:01Z', event: 'drain-dispatch', taskId: '8', subject: 'x', contentHash: 'h1' },
  ];
  const tasksById = new Map([['8', { id: '8', status: 'pending' }]]);
  const out = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchEntries,
    new Date('2026-08-04T12:00:00Z'), { strandedCommits: () => 0 });
  // Both dispatches correlate to the same single job, so exactly one outcome —
  // the in-pass `emitted` guard stops the second from double-charging it.
  assert.equal(out.length, 1);
});

// ── attribution: `completed` alone is NOT proof the drain did the work ──────
// Real incident 2026-08-05 (task #68): the ledger recorded
//   {"event":"card-fail","cardId":"68","note":"job job-failed: timeout"}
// while ~/.claude/tasks/broadwayscore/68.json said status "completed". The
// session had finished the work; only its job wrapper timed out. Scoring that a
// failure fed a phantom failure into both the spend breaker and attempt-memory.
// The fix must credit it — but ONLY when the drain's own branch actually landed,
// because task.status is a shared mirror any writer can flip (a human clicking
// Done in Notion, notion-tasks-sync's pull, or a parallel Cmux session).
// Crediting an unattributed completion would be worse than the original bug:
// spendCircuitBreakerStatus only halts while completions === 0, so one false
// pass suppresses every real card-fail in that 24h window.

const RECON_ARGS = (taskStatus, jobEvent) => [
  [{ ts: '2026-08-04T22:00:00Z', event: 'drain-dispatch', taskId: '68', contentHash: 'h68' }],
  new Map([['68', { id: '68', status: taskStatus }]]),
  [
    { ts: '2026-08-04T22:00:05Z', event: dispatchLedger.JOB_EVENTS.SPAWNED, taskId: '68', jobId: 'j68' },
    { ts: '2026-08-05T14:00:00Z', event: jobEvent, taskId: '68', jobId: 'j68', costUSD: 0, stage: 'timeout' },
  ],
  new Date('2026-08-05T14:00:01Z'),
];

test('reconcileOutcomes: job TIMED OUT but the card completed AND job branch landed → card-pass (task #68)', () => {
  const out = reconcileOutcomes(...RECON_ARGS('completed', dispatchLedger.JOB_EVENTS.FAILED),
    { jobBranchLanded: () => true, taskCommitLandedInWindow: () => false, strandedCommits: () => 0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'card-pass', 'a timed-out job whose own branch landed is a real completion');
  assert.match(out[0].note, /landed on main/);
});

test('reconcileOutcomes: card completed but job branch did NOT land → completion-unattributed, never card-pass', () => {
  const out = reconcileOutcomes(...RECON_ARGS('completed', dispatchLedger.JOB_EVENTS.FAILED),
    { jobBranchLanded: () => false, taskCommitLandedInWindow: () => false, strandedCommits: () => 0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'completion-unattributed',
    'someone else closed the card — crediting it would suppress the spend breaker');
  assert.notEqual(out[0].event, 'card-pass');
});

test('reconcileOutcomes: stranded commits are inspected even when the job did NOT finish cleanly', () => {
  // Pre-fix this was gated on sessionOk, so a timed-out job that left real work
  // was scored a plain card-fail and its commits were never even counted.
  const out = reconcileOutcomes(...RECON_ARGS('pending', dispatchLedger.JOB_EVENTS.FAILED),
    { jobBranchLanded: () => false, taskCommitLandedInWindow: () => false, strandedCommits: () => 3 });
  assert.equal(out[0].event, 'card-stranded');
  assert.equal(out[0].strandedCommits, 3);
});

test('reconcileOutcomes: clean job + completed card is still a plain card-pass (no regression)', () => {
  const out = reconcileOutcomes(...RECON_ARGS('completed', dispatchLedger.JOB_EVENTS.DONE),
    { jobBranchLanded: () => false, taskCommitLandedInWindow: () => false, strandedCommits: () => 0 });
  assert.equal(out[0].event, 'card-pass');
  assert.equal(out[0].note, 'session finished, task marked completed');
});

test('reconcileOutcomes: branch deleted but a commit referencing the task landed in-window → card-pass via commit-ref', () => {
  // The REAL #68: work landed as 6042f5ae27a ("...(task #68)...") but
  // worktree-gc deleted job/68-msf7br29, so branch-ancestor alone said "not
  // attributable" — a false negative on the exact case this fix exists for.
  const out = reconcileOutcomes(...RECON_ARGS('completed', dispatchLedger.JOB_EVENTS.FAILED),
    { jobBranchLanded: () => false, taskCommitLandedInWindow: () => true, strandedCommits: () => 0 });
  assert.equal(out[0].event, 'card-pass');
  assert.equal(out[0].attribution, 'commit-ref');
});

test('reconcileOutcomes: passes the job\'s OWN window to the commit-ref lookup, not an open-ended range', () => {
  // Review finding: every other attribution test stubs the lookup as ()=>true/false,
  // so nothing asserted WHAT window it receives. A widened window would credit the
  // drain for an interactive session that touched the same card later.
  const seen = [];
  reconcileOutcomes(...RECON_ARGS('completed', dispatchLedger.JOB_EVENTS.FAILED), {
    jobBranchLanded: () => false,
    taskCommitLandedInWindow: (taskId, fromTs, toTs) => { seen.push({ taskId, fromTs, toTs }); return false; },
    strandedCommits: () => 0,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, '68');
  assert.equal(seen[0].fromTs, '2026-08-04T22:00:00Z', 'window opens at the drain-dispatch, not epoch');
  assert.equal(seen[0].toTs, '2026-08-05T14:00:00Z', 'window closes at the job\'s terminal event');
});
