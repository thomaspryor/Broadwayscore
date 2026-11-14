// scripts/tests/dispatch-outcome-digest.test.mjs
//
// Acceptance test for task #1106: audit-dispatch-outcomes.js correctly
// classifies dispatches but nothing runs it, so abandoned dispatches go
// unseen for up to 14 days. This tests the pure function
// (scripts/lib/dispatch-outcome-digest.js) that turns a classification into
// the one digest row scripts/health-check.js emits.
//
// Per CLAUDE.md rule 15 this require()s the real function — including the
// real classifyDispatches() it wraps — rather than restating the counting
// logic here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDispatchOutcomeDigest } = require('../lib/dispatch-outcome-digest.js');

const NOW = Date.parse('2026-08-06T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const launchEvent = (over = {}) => ({
  event: 'launch',
  ts: daysAgo(5),
  taskId: '1',
  workspaceRef: 'workspace:1',
  subject: 'Test dispatch',
  ...over,
});

const tasksMap = (entries) => new Map(entries.map(([id, t]) => [String(id), t]));

test('a non-zero abandoned count produces a row naming the count and the oldest launchedAt', () => {
  const dispatchLedgerEntries = [
    launchEvent({ taskId: '1', ts: daysAgo(10), workspaceRef: 'workspace:1' }),
    launchEvent({ taskId: '2', ts: daysAgo(3), workspaceRef: 'workspace:2' }),
  ];
  // Neither task completed, and cmux reports neither workspace live — both
  // dispatches are abandoned. Oldest launch (task 1, 10 days ago) must be
  // the one named in the row.
  const tasksById = tasksMap([
    ['1', { status: 'in_progress' }],
    ['2', { status: 'in_progress' }],
  ]);

  const row = computeDispatchOutcomeDigest({
    dispatchLedgerEntries,
    tasksById,
    liveWorkspaceRefs: new Set(), // cmux observed — neither workspace is live
  });

  assert.ok(row, 'expected a row for a non-zero abandoned count');
  assert.equal(row.status, 'warn');
  assert.equal(row.abandonedCount, 2);
  assert.equal(row.oldestAbandonedLaunchedAt, dispatchLedgerEntries[0].ts);
  assert.match(row.message, /2 dispatch\(es\) abandoned/);
  assert.ok(row.message.includes(dispatchLedgerEntries[0].ts), 'message must name the oldest launchedAt');
});

test('a flat day-over-day abandoned count produces NO row (ACTION-only email policy)', () => {
  const dispatchLedgerEntries = [launchEvent({ taskId: '1', ts: daysAgo(10) })];
  const tasksById = tasksMap([['1', { status: 'in_progress' }]]);

  const row = computeDispatchOutcomeDigest({
    dispatchLedgerEntries,
    tasksById,
    liveWorkspaceRefs: new Set(),
    previousAbandonedCount: 1, // same as today's computed count
  });

  assert.equal(row, null);
});

test('an empty/unreadable task store THROWS rather than reporting 0 (vacuous-gate class)', () => {
  const dispatchLedgerEntries = [launchEvent()];
  assert.throws(
    () => computeDispatchOutcomeDigest({ dispatchLedgerEntries, tasksById: new Map() }),
    /empty\/unreadable task store/
  );
  assert.throws(
    () => computeDispatchOutcomeDigest({ dispatchLedgerEntries, tasksById: undefined }),
    /empty\/unreadable task store/
  );
});

test('zero abandoned dispatches (all landed) produces no row', () => {
  const dispatchLedgerEntries = [launchEvent({ taskId: '1', ts: daysAgo(10) })];
  const tasksById = tasksMap([['1', { status: 'completed' }]]);

  const row = computeDispatchOutcomeDigest({ dispatchLedgerEntries, tasksById });
  assert.equal(row, null);
});

test('previousAbandonedCount null (first run) still produces a row for a non-zero count', () => {
  const dispatchLedgerEntries = [launchEvent({ taskId: '1', ts: daysAgo(10) })];
  const tasksById = tasksMap([['1', { status: 'in_progress' }]]);

  const row = computeDispatchOutcomeDigest({
    dispatchLedgerEntries, tasksById, liveWorkspaceRefs: new Set(), previousAbandonedCount: null,
  });

  assert.ok(row);
  assert.equal(row.abandonedCount, 1);
});

test('an abandoned count that CHANGED from the previous run (not just flat) produces a row', () => {
  const dispatchLedgerEntries = [
    launchEvent({ taskId: '1', ts: daysAgo(10) }),
    launchEvent({ taskId: '2', ts: daysAgo(9) }),
  ];
  const tasksById = tasksMap([
    ['1', { status: 'in_progress' }],
    ['2', { status: 'in_progress' }],
  ]);

  // 2 abandoned today, only 1 yesterday — a real change, must alert.
  const row = computeDispatchOutcomeDigest({
    dispatchLedgerEntries, tasksById, liveWorkspaceRefs: new Set(), previousAbandonedCount: 1,
  });

  assert.ok(row);
  assert.equal(row.abandonedCount, 2);
});
