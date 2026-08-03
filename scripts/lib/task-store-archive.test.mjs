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
  // Direct test of the re-check line rather than a scan/move race, which
  // needs a live TaskUpdate racing the archiver to reproduce — not
  // reproducible from a unit test. A task that is NOT completed/in_progress
  // (e.g. reopened to pending) must never be archived, full stop;
  // selectArchivable already guarantees the scan phase agrees, so this pins
  // the move-phase guard as an independent line of defense.
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'pending' }, 1000);
  fs.mkdirSync(path.join(dir, 'archive'));
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, []);
  assert.equal(fs.existsSync(path.join(dir, '1.json')), true);
});

test('selectArchivable: picks in_progress tasks untouched longer than staleInProgressMs (card #955)', () => {
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 200 * HOUR }, // >7d
    { id: '2', status: 'in_progress', mtimeMs: NOW - 10 * HOUR }, // recent, active
    { id: '3', status: 'pending', mtimeMs: NOW - 200 * HOUR }, // never archived regardless of age
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectArchivable: staleInProgressMs: Infinity disables the in_progress population entirely', () => {
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 10_000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0, staleInProgressMs: Infinity }), []);
});

test('selectArchivable: in_progress orphans still respect keepTopN frontier', () => {
  const tasks = [
    { id: '10', status: 'in_progress', mtimeMs: NOW - 1000 * HOUR },
    { id: '11', status: 'in_progress', mtimeMs: NOW - 1000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 1 }), ['10']);
});

test('archiveCompletedTasks: move-time recheck uses fresh fs.statSync, not the scan snapshot (race guard)', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress' }, 200);
  const livePath = path.join(dir, '1.json');
  const origStat = fs.statSync;
  let calls = 0;
  fs.statSync = (p, ...rest) => {
    if (p === livePath) {
      calls += 1;
      if (calls === 2) { // second stat = the move-time recheck
        const fresh = new Date(NOW); // task was just touched — no longer stale
        fs.utimesSync(livePath, fresh, fresh);
      }
    }
    return origStat(p, ...rest);
  };
  try {
    const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
    assert.deepEqual(result.archived, []);
    assert.deepEqual(result.skipped.map((s) => s.id), ['1']);
    assert.equal(fs.existsSync(livePath), true);
  } finally {
    fs.statSync = origStat;
  }
});

test('archiveCompletedTasks: archives a stale in_progress orphan end-to-end', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'dead session claim' }, 200);
  writeTask(dir, 2, { status: 'in_progress' }, 1); // fresh, must stay live
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, ['1']);
  assert.equal(fs.existsSync(path.join(dir, '1.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '2.json')), true);
  const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', '1.json'), 'utf8'));
  assert.equal(archived.subject, 'dead session claim');
});
