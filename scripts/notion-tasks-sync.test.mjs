import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mapStatus, mapCardToTask, planPull } = require('./notion-tasks-sync.js');

test('mapStatus maps Notion → native task status', () => {
  assert.equal(mapStatus('In progress'), 'in_progress');
  assert.equal(mapStatus('Done'), 'completed');
  assert.equal(mapStatus('Not started'), 'pending');
  assert.equal(mapStatus('Paused'), 'pending');
  assert.equal(mapStatus(undefined), 'pending');
});

test('mapCardToTask embeds notion page id and traces back', () => {
  const card = { id: 'abc123', url: 'https://n/x', name: 'Fix scoring', status: 'In progress', priority: 'P0 Now', notes: 'a\n\n  b   c' };
  const t = mapCardToTask(card, 7);
  assert.equal(t.id, '7');
  assert.equal(t.subject, 'Fix scoring');
  assert.equal(t.status, 'in_progress');
  assert.match(t.description, /\[notion:abc123\]/);
  assert.match(t.description, /P0 Now/);
  assert.match(t.description, /a b c/); // whitespace collapsed
  assert.deepEqual(t.blocks, []);
  assert.deepEqual(t.blockedBy, []);
});

test('planPull creates unmapped cards, updates on status change, else unchanged', () => {
  const cards = [
    { id: 'new', status: 'Not started' },
    { id: 'moved', status: 'In progress' },
    { id: 'same', status: 'In progress' },
  ];
  const map = {
    moved: { taskId: '2', syncedStatus: 'Not started' },
    same: { taskId: '3', syncedStatus: 'In progress' },
  };
  const plan = planPull(cards, map);
  assert.deepEqual(plan.toCreate.map(x => x.card.id), ['new']);
  assert.deepEqual(plan.toUpdate.map(x => ({ id: x.card.id, taskId: x.taskId })), [{ id: 'moved', taskId: '2' }]);
  assert.deepEqual(plan.unchanged, ['same']);
});

test('planPull is idempotent: re-running with a fully-synced map is a no-op', () => {
  const cards = [{ id: 'a', status: 'In progress' }, { id: 'b', status: 'Not started' }];
  const map = { a: { taskId: '1', syncedStatus: 'In progress' }, b: { taskId: '2', syncedStatus: 'Not started' } };
  const plan = planPull(cards, map);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.toUpdate.length, 0);
  assert.deepEqual(plan.unchanged.sort(), ['a', 'b']);
});
