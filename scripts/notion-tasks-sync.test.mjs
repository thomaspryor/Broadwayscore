import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { mapStatus, mapCardToTask, planPull, allocateFreeId, taskBelongsTo, notionMarker, writeTask, readHwm, writeHwm, acquireLock } = require('./notion-tasks-sync.js');

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
    moved: { taskId: '2', syncedStatus: 'Not started', fmt: 2 },
    same: { taskId: '3', syncedStatus: 'In progress', fmt: 2 },
  };
  const plan = planPull(cards, map);
  assert.deepEqual(plan.toCreate.map(x => x.card.id), ['new']);
  assert.deepEqual(plan.toUpdate.map(x => ({ id: x.card.id, taskId: x.taskId })), [{ id: 'moved', taskId: '2' }]);
  assert.deepEqual(plan.unchanged, ['same']);
});

test('planPull is idempotent: re-running with a fully-synced map is a no-op', () => {
  const cards = [{ id: 'a', status: 'In progress' }, { id: 'b', status: 'Not started' }];
  const map = { a: { taskId: '1', syncedStatus: 'In progress', fmt: 2 }, b: { taskId: '2', syncedStatus: 'Not started', fmt: 2 } };
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

test('mapCardToTask mirrors category as third meta segment', () => {
  const t = mapCardToTask({ id: 'x', name: 'N', status: 'Not started', priority: 'P0 Now', category: 'Marketing', notes: '' }, 1);
  assert.match(t.description.split('\n')[0], /· Marketing$/);
  const t2 = mapCardToTask({ id: 'y', name: 'N', status: 'Not started' }, 2);
  assert.match(t2.description.split('\n')[0], /· no-category$/);
});

test('planPull upgrades pre-fmt2 entries even when status unchanged', () => {
  const cards = [{ id: 'a', status: 'Not started', category: 'Product' }];
  const oldMap = { a: { taskId: '1', syncedStatus: 'Not started' } };          // no fmt
  const newMap = { a: { taskId: '1', syncedStatus: 'Not started', fmt: 2 } };
  assert.equal(planPull(cards, oldMap).toUpdate.length, 1);  // format upgrade
  assert.equal(planPull(cards, newMap).unchanged.length, 1); // idempotent after
});

// ── Autonomous-loop claim protection (Sprint-2 carry-forward #1) ────────────
// notion-tasks-sync deliberately ignores the Auto property; the executor's
// Status→"In progress" flip is the ONLY thing keeping a claimed card from
// being double-picked via the task mirror. Lock both halves of that contract.

test('executor claim: a card flipped to In progress mirrors as in_progress, never pending', () => {
  const { mergeStatus } = require('./notion-tasks-sync.js');
  // The claimed card syncs with Notion status "In progress"
  const task = mapCardToTask({ id: 'c', name: 'Claimed card', status: 'In progress', category: 'Product' }, 7);
  assert.equal(task.status, 'in_progress');
  // and a pull can never downgrade an in-progress task back to pending
  assert.equal(mergeStatus('in_progress', 'pending'), 'in_progress');
  assert.equal(mergeStatus('completed', 'pending'), 'completed');
  assert.equal(mergeStatus('completed', 'in_progress'), 'completed');
  // forward progress still flows
  assert.equal(mergeStatus('pending', 'in_progress'), 'in_progress');
  assert.equal(mergeStatus('pending', 'completed'), 'completed');
  assert.equal(mergeStatus(undefined, 'pending'), 'pending');
});

// ── #485: .sync-lock staleness must use its own acquiredAt, not fs mtime ────
// Same bug class as json-write-guard.js and #476's monitor.lock: mtime is
// trivially reset by any unrelated process touching the lock file.

test('#485: a live lock (fresh acquiredAt) is NOT stolen even if its mtime is old', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min old mtime, well past the 2-min TTL
  fs.utimesSync(lockPath, old, old);
  const release = acquireLock(dir);
  assert.equal(release, null, 'a fresh acquiredAt must block acquisition regardless of stale mtime');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#485: a stale lock (old acquiredAt) is stolen even if its mtime was just touched', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() }));
  fs.utimesSync(lockPath, new Date(), new Date()); // unrelated touch resets mtime to "now"
  const release = acquireLock(dir);
  assert.ok(typeof release === 'function', 'a stale acquiredAt must be stolen despite a fresh mtime');
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#485: an old-format lock (bare PID, no acquiredAt) falls back to mtime staleness', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, String(process.pid)); // pre-fix format
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const release = acquireLock(dir);
  assert.ok(typeof release === 'function', 'old-format lock past the mtime TTL must still be stealable');
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});
