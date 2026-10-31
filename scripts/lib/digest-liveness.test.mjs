import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { taskHasLiveSession, applyLivenessGate } = require('./digest-liveness.js');

const SUBJECT = 'Fix: BSC Daily: Workflow repeat-failure: Test Suite is failing on every run';

test('taskHasLiveSession: true when ref is live, title matches subject, and process is alive', () => {
  const entries = [{ event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' }];
  const liveWorkspaces = [{ ref: 'workspace:10', title: `🤖 Data·${SUBJECT}` }];
  assert.equal(taskHasLiveSession('733', { dispatchLedgerEntries: entries, liveWorkspaces, isProcessAlive: () => true }), true);
});

test('taskHasLiveSession: false when the ledger\'s launch ref vanished from cmux (the #940 phantom case)', () => {
  const entries = [{ event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' }];
  assert.equal(taskHasLiveSession('733', { dispatchLedgerEntries: entries, liveWorkspaces: [], isProcessAlive: () => true }), false);
});

test('taskHasLiveSession: false when the workspace ref is listed but its process is dead (listing alone is not proof)', () => {
  const entries = [{ event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' }];
  const liveWorkspaces = [{ ref: 'workspace:10', title: `🤖 Data·${SUBJECT}` }];
  assert.equal(taskHasLiveSession('733', { dispatchLedgerEntries: entries, liveWorkspaces, isProcessAlive: () => false }), false);
});

test('taskHasLiveSession: false when the ref was reused by an unrelated task (title no longer matches the recorded subject)', () => {
  const entries = [{ event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' }];
  const liveWorkspaces = [{ ref: 'workspace:10', title: '🤖 Data·Completely unrelated new card after a cmux restart' }];
  assert.equal(taskHasLiveSession('733', { dispatchLedgerEntries: entries, liveWorkspaces, isProcessAlive: () => true }), false);
});

test('taskHasLiveSession: false when the launch was already reconciled dead in the ledger', () => {
  const entries = [
    { event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' },
    { event: 'dead', taskId: '733', workspaceRef: 'workspace:10', ts: '2026-08-03T08:00:00Z' },
  ];
  const liveWorkspaces = [{ ref: 'workspace:10', title: `🤖 Data·${SUBJECT}` }];
  assert.equal(taskHasLiveSession('733', { dispatchLedgerEntries: entries, liveWorkspaces, isProcessAlive: () => true }), false);
});

test('taskHasLiveSession: true for an open headless job with no workspace at all', () => {
  const entries = [{ event: 'job-spawned', jobId: 'j1', taskId: '807' }];
  assert.equal(taskHasLiveSession('807', { dispatchLedgerEntries: entries, liveWorkspaces: [] }), true);
});

test('taskHasLiveSession: false for a headless job that already finished', () => {
  const entries = [
    { event: 'job-spawned', jobId: 'j1', taskId: '807' },
    { event: 'job-done', jobId: 'j1', taskId: '807' },
  ];
  assert.equal(taskHasLiveSession('807', { dispatchLedgerEntries: entries, liveWorkspaces: [] }), false);
});

test('taskHasLiveSession: no ledger entries at all → false, never throws', () => {
  assert.equal(taskHasLiveSession('999', {}), false);
});

test('applyLivenessGate: downgrades an in-progress row with no live proof to no-live-session', () => {
  const rows = [{ name: 'Test Suite', taskId: '733', state: 'in-progress' }];
  const gated = applyLivenessGate(rows, { dispatchLedgerEntries: [], liveWorkspaces: [] });
  assert.equal(gated[0].state, 'no-live-session');
  assert.equal(gated[0].priorState, 'in-progress');
  assert.equal(gated[0].liveConfirmed, false);
});

test('applyLivenessGate: keeps in-progress when the workspace is confirmed live end-to-end', () => {
  const rows = [{ name: 'Test Suite', taskId: '733', state: 'in-progress' }];
  const entries = [{ event: 'launch', taskId: '733', workspaceRef: 'workspace:10', subject: SUBJECT, ts: '2026-08-03T07:00:00Z' }];
  const liveWorkspaces = [{ ref: 'workspace:10', title: `🤖 Data·${SUBJECT}` }];
  const gated = applyLivenessGate(rows, { dispatchLedgerEntries: entries, liveWorkspaces, isProcessAlive: () => true });
  assert.equal(gated[0].state, 'in-progress');
  assert.equal(gated[0].liveConfirmed, true);
});

test('applyLivenessGate: never touches dispatched/queued/decision/acknowledged rows', () => {
  const rows = [
    { name: 'A', taskId: '1', state: 'dispatched' },
    { name: 'B', taskId: '2', state: 'queued' },
    { name: 'C', taskId: null, state: 'decision' },
    { name: 'D', taskId: '4', state: 'acknowledged' },
  ];
  const gated = applyLivenessGate(rows, { dispatchLedgerEntries: [], liveWorkspaces: [] });
  assert.deepEqual(gated.map(r => r.state), ['dispatched', 'queued', 'decision', 'acknowledged']);
});

test('applyLivenessGate: passes through non-array input unchanged', () => {
  assert.equal(applyLivenessGate(null, {}), null);
  assert.equal(applyLivenessGate(undefined, {}), undefined);
});
