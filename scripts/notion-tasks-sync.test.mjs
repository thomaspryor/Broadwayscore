import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { mapStatus, mapCardToTask, planPull, allocateFreeId, taskBelongsTo, notionMarker, writeTask, readHwm, writeHwm } = require('./notion-tasks-sync.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nts-')); }

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

test('allocateFreeId skips ids a live session already occupies', () => {
  const dir = tmpDir();
  writeTask(dir, mapCardToTask({ id: 'x', name: 'a session task' }, 3));
  writeTask(dir, mapCardToTask({ id: 'y', name: 'another' }, 4));
  assert.equal(allocateFreeId(dir, 3), 5); // 3 and 4 taken → 5
  assert.equal(allocateFreeId(dir, 1), 1); // 1 free
  fs.rmSync(dir, { recursive: true, force: true });
});

test('taskBelongsTo proves ownership via the [notion:<pageId>] marker', () => {
  const dir = tmpDir();
  writeTask(dir, mapCardToTask({ id: 'pageA', name: 'mine' }, 7));
  assert.equal(taskBelongsTo(dir, 7, 'pageA'), true);
  assert.equal(taskBelongsTo(dir, 7, 'pageB'), false); // reused id, different card
  assert.equal(taskBelongsTo(dir, 99, 'pageA'), false); // missing file
  // a stranger's task (no marker) is never claimed
  writeTask(dir, { id: '8', subject: 's', description: 'unrelated work', status: 'completed', blocks: [], blockedBy: [] });
  assert.equal(taskBelongsTo(dir, 8, 'pageA'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHwm never regresses below a concurrent bump', () => {
  const dir = tmpDir();
  writeHwm(dir, 10);
  assert.equal(readHwm(dir), 10);
  writeHwm(dir, 5); // stale/lower value must not win
  assert.equal(readHwm(dir), 10);
  writeHwm(dir, 12);
  assert.equal(readHwm(dir), 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('notionMarker format is stable', () => {
  assert.equal(notionMarker('abc-123'), '[notion:abc-123]');
});
