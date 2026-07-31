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
