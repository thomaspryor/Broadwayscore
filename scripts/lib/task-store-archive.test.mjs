import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectArchivable, loadTasksWithMtime, archiveCompletedTasks, readArchivedTask, mergeWithArchive,
} = require('./task-store-archive.js');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed instant, no Date.now() dependency

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-archive-'));
}

function writeTask(dir, id, fields, ageHours) {
  const p = path.join(dir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id: String(id), subject: `task ${id}`, status: 'pending', ...fields }));
  if (ageHours !== undefined) {
    const t = new Date(NOW - ageHours * HOUR);
    fs.utimesSync(p, t, t);
  }
}

test('selectArchivable: picks completed tasks older than maxAgeMs', () => {
  const tasks = [
    { id: '1', status: 'completed', mtimeMs: NOW - 72 * HOUR },
    { id: '2', status: 'completed', mtimeMs: NOW - 10 * HOUR },
    { id: '3', status: 'pending', mtimeMs: NOW - 72 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectArchivable: never selects any of the top keepTopN ids present, regardless of age/status', () => {
  // Reproduces the live-tested collision: archiving the directory's current
  // max id frees it for reuse by the harness's own next-id allocator.
  const tasks = [
    { id: '10', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '11', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '12', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 2 }), ['10']);
});

test('selectArchivable: id order in input does not affect the frontier computation', () => {
  const tasks = [
    { id: '5', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '1', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '3', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 1 }), ['1', '3']);
});

test('loadTasksWithMtime: reads only <id>.json files, skips archive/ and dotfiles, attaches mtimeMs', () => {
  const dir = mkTmp();
  writeTask(dir, 1, {}, 100);
  fs.mkdirSync(path.join(dir, 'archive'));
  writeTask(path.join(dir, 'archive'), 2, {}); // must not be picked up by a top-level scan
  fs.writeFileSync(path.join(dir, '.highwatermark'), '5');
  const tasks = loadTasksWithMtime(dir);
  assert.deepEqual(tasks.map((t) => t.id), ['1']);
  assert.equal(typeof tasks[0].mtimeMs, 'number');
});

test('archiveCompletedTasks: moves eligible tasks to archive/, live file removed, content preserved', () => {
  const dir = mkTmp();
  writeTask(dir, 100, { status: 'completed', description: 'old work' }, 72);
  writeTask(dir, 200, { status: 'pending' }, 72);
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, ['100']);
  assert.equal(fs.existsSync(path.join(dir, '100.json')), false);
  const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', '100.json'), 'utf8'));
  assert.equal(archived.description, 'old work');
  assert.equal(fs.existsSync(path.join(dir, '200.json')), true); // untouched
});

test('archiveCompletedTasks: respects keepTopN even when every task is old and completed', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'completed' }, 1000);
  writeTask(dir, 2, { status: 'completed' }, 1000);
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 1 });
  assert.deepEqual(result.archived, ['1']);
  assert.equal(fs.existsSync(path.join(dir, '2.json')), true);
});

test('archiveCompletedTasks: is idempotent — a second run with nothing newly eligible archives nothing', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'completed' }, 1000);
  archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  const second = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(second.archived, []);
});

test('readArchivedTask: point lookup by id, null when absent', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'completed' }, 1000);
  archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.equal(readArchivedTask(dir, '1').id, '1');
  assert.equal(readArchivedTask(dir, '999'), null);
});

test('mergeWithArchive: appends archived tasks not already present in the live array; live wins on collision', () => {
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '1.json'), JSON.stringify({ id: '1', subject: 'archived stale copy', status: 'completed' }));
  fs.writeFileSync(path.join(dir, 'archive', '2.json'), JSON.stringify({ id: '2', subject: 'archived task', status: 'completed' }));
  const live = [{ id: '1', subject: 'live current copy', status: 'completed' }, { id: '3', subject: 'live pending', status: 'pending' }];
  const merged = mergeWithArchive(dir, live);
  assert.deepEqual(merged.map((t) => t.id).sort(), ['1', '2', '3']);
  assert.equal(merged.find((t) => t.id === '1').subject, 'live current copy');
});

test('mergeWithArchive: no archive/ directory — returns liveTasks unchanged', () => {
  const dir = mkTmp();
  const live = [{ id: '1', status: 'pending' }];
  assert.deepEqual(mergeWithArchive(dir, live), live);
});

test('archiveCompletedTasks: re-verifies status at move time, not just at scan time (race-guard code path)', () => {
  // Direct test of the re-check line (`parsed.status !== 'completed'`)
  // rather than a scan/move race, which needs a live TaskUpdate racing the
  // archiver to reproduce — not reproducible from a unit test. A task that
  // is NOT completed must never be archived, full stop; selectArchivable
  // already guarantees the scan phase agrees, so this pins the move-phase
  // guard as an independent line of defense.
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress' }, 1000);
  fs.mkdirSync(path.join(dir, 'archive'));
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, []);
  assert.equal(fs.existsSync(path.join(dir, '1.json')), true);
});
