import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyDispatches, abandonedDispatches, OUTCOMES } = require('../lib/dispatch-outcome.js');

// The real 2026-08-05 shape: a card is dispatched, its workspace later dies, and
// the card never completes. Today nothing notices — autonomous-acceptance-recheck.js
// only queries `--status Done,Paused`, so in-flight work is invisible and the card
// sits `in_progress` forever. That is why 97 cards read in_progress against 13 live
// workspaces.
const L = (taskId, ts, extra = {}) => ({ event: 'launch', taskId, ts, workspaceRef: `workspace:${taskId}`, subject: `card ${taskId}`, ...extra });

test('a dispatch whose workspace died and whose card never completed is ABANDONED', () => {
  const entries = [L('500', '2026-08-05T10:00:00Z'), { event: 'dead', taskId: '500', ts: '2026-08-05T12:00:00Z' }];
  const tasks = new Map([['500', { status: 'in_progress' }]]);
  const [r] = classifyDispatches(entries, tasks);
  assert.equal(r.outcome, OUTCOMES.ABANDONED);
  assert.equal(r.workspaceRef, 'workspace:500');
});

test('a dispatch whose card completed is LANDED even though its workspace is gone', () => {
  // Normal, healthy shape: work finished, tab pruned afterwards. Must NOT be flagged.
  const entries = [L('501', '2026-08-05T10:00:00Z'), { event: 'prune-closed', taskId: '501', ts: '2026-08-05T12:00:00Z' }];
  const tasks = new Map([['501', { status: 'completed' }]]);
  assert.equal(classifyDispatches(entries, tasks)[0].outcome, OUTCOMES.LANDED);
});

test('a live dispatch with no terminal event is IN-FLIGHT, not abandoned', () => {
  const entries = [L('502', '2026-08-05T10:00:00Z')];
  const tasks = new Map([['502', { status: 'in_progress' }]]);
  assert.equal(classifyDispatches(entries, tasks)[0].outcome, OUTCOMES.IN_FLIGHT);
});

test('a re-dispatch supersedes an earlier dead attempt — the retry is not condemned', () => {
  // Without last-launch-wins, the old `dead` event would mark a card abandoned
  // while its replacement session is actively running.
  const entries = [
    L('503', '2026-08-05T09:00:00Z'),
    { event: 'dead', taskId: '503', ts: '2026-08-05T09:30:00Z' },
    L('503', '2026-08-05T14:00:00Z'),
  ];
  const tasks = new Map([['503', { status: 'in_progress' }]]);
  assert.equal(classifyDispatches(entries, tasks)[0].outcome, OUTCOMES.IN_FLIGHT);
});

test('cmux-crash case: workspace absent from the live set counts as abandoned even with no terminal ledger event', () => {
  // The 2026-08-03 cmux restart killed tabs without anything writing `dead`.
  const entries = [L('504', '2026-08-05T10:00:00Z')];
  const tasks = new Map([['504', { status: 'in_progress' }]]);
  const opts = { liveWorkspaceRefs: new Set(['workspace:999']) };
  assert.equal(classifyDispatches(entries, tasks, opts)[0].outcome, OUTCOMES.ABANDONED);
  assert.equal(classifyDispatches(entries, tasks)[0].outcome, OUTCOMES.IN_FLIGHT, 'without the live set, only the ledger is trusted');
});

test('abandonedDispatches returns only the ones needing action', () => {
  const entries = [
    L('600', '2026-08-05T10:00:00Z'), { event: 'dead', taskId: '600', ts: '2026-08-05T11:00:00Z' },
    L('601', '2026-08-05T10:00:00Z'),
    L('602', '2026-08-05T10:00:00Z'), { event: 'prune-closed', taskId: '602', ts: '2026-08-05T11:00:00Z' },
  ];
  const tasks = new Map([['600', { status: 'in_progress' }], ['601', { status: 'in_progress' }], ['602', { status: 'completed' }]]);
  const ids = abandonedDispatches(entries, tasks).map(r => r.taskId);
  assert.deepEqual(ids, ['600']);
});
