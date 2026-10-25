/**
 * watchdog-skips-landed-acked.test.mjs — BRO-4076 acceptance criteria,
 * pinned to their own dedicated file: a ledger whose newest row for a card
 * is landed-acked must be excluded from the p01-backlog watchdog's undispatched
 * P0/P1 queue; a card whose newest row is job-spawned must still be eligible.
 *
 * Per CLAUDE.md §15 this require()s the real dispatch-watchdog-core.js
 * selector (planSweep/hasNoFurtherDispatchWork) rather than reimplementing
 * the logic — a production regression breaks this test, which is the point.
 * Fuller coverage (the retry-loop bypass, the prune-closed race, job-spawned
 * tested directly against the pure predicate) lives alongside the rest of
 * this module's test suite in scripts/tests/dispatch-watchdog-core.test.mjs
 * and scripts/lib/dispatch-ledger.test.mjs — this file is the acceptance-
 * criteria pin, not a duplicate of that coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');

const NOW = Date.parse('2026-09-23T09:00:00Z');
const T = (m) => new Date(NOW - m * 60000).toISOString();

function pendingP0(identifier) {
  const id = `linear:${identifier}`;
  return [id, {
    id, subject: `Fix ${identifier}`, status: 'pending',
    description: `[linear:${identifier}] P0 Now · Backlog · no-category\nbody`,
  }];
}

const LIVE = new Map([['workspace:1', 'x'], ['workspace:99', 'y']]);

test('BRO-4076 acceptance: ledger with newest row landed-acked for card X -> watchdog selector excludes X', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-9100', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'job-stopped-short', taskId: 'linear:BRO-9100' },
    { ts: T(10), event: 'landed-acked', taskId: 'linear:BRO-9100', jobId: 'j1', sha: 'abc123' },
  ];
  const tasks = new Map([pendingP0('BRO-9100')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map((q) => q.taskId), [],
    'a card whose newest ledger row is landed-acked must not be selected for redispatch');
});

test('BRO-4076 acceptance: ledger with newest row job-spawned for card X -> X is still eligible', () => {
  // job-spawned itself always lands the task in planSweep's `open` set (a
  // non-terminal folded job) — that pre-existing exclusion, not this
  // ticket's new check, is what keeps an in-flight dispatch out of
  // p01Queue. "Still eligible" is exercised directly against the new
  // predicate the queue now consults, which is the thing this acceptance
  // criterion is actually about.
  const entries = [{ ts: T(1), event: 'job-spawned', taskId: 'linear:BRO-9100', jobId: 'j1' }];
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-9100', entries), false);
});
