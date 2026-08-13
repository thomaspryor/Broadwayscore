import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectArchivable, archiveCopyFor, loadTasksWithMtime, archiveCompletedTasks,
  readArchivedTask, mergeWithArchive, DEFAULT_KEEP_TOP_N,
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

// Card #1410: every OTHER frontier test above passes keepTopN explicitly, so
// the real DEFAULT_KEEP_TOP_N constant itself had zero coverage — a
// regression back to 50 (or any value that reopens frontier shadowing) would
// pass every existing test. Pin the production default directly: even when
// every task is old/eligible, the current max id must never be selected.
test('selectArchivable: DEFAULT_KEEP_TOP_N (no explicit keepTopN) never selects the current max id', () => {
  const tasks = [
    { id: '10', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '11', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
    { id: '12', status: 'completed', mtimeMs: NOW - 1000 * HOUR },
  ];
  const archived = selectArchivable(tasks, { now: NOW }); // no keepTopN — real default
  assert.ok(!archived.includes('12'), 'the current max id must never be archived under the production default');
  assert.equal(DEFAULT_KEEP_TOP_N, 1, 'this test assumes the documented minimum — update it if the constant changes');
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
  // reproducible from a unit test. A task whose status is outside the three
  // archivable statuses (completed/in_progress/pending — e.g. some future
  // or unrecognized status) must never be archived, full stop; selectArchivable
  // already guarantees the scan phase agrees, so this pins the move-phase
  // guard as an independent line of defense.
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'someOtherStatus' }, 1000);
  fs.mkdirSync(path.join(dir, 'archive'));
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, []);
  assert.equal(fs.existsSync(path.join(dir, '1.json')), true);
});

// THE DEADLOCK FIX lives in the ARCHIVE COPY, not in the live dir. An earlier
// version of this fix removed in_progress from archival and flipped LIVE files
// to pending; code review caught that it reimplemented
// sweepUntrackedInProgress's flip minus all of its guards, and that refusing to
// archive in_progress left that population with no exit path from the live dir
// at all. So in_progress is archivable again (boundedness restored) and the
// filed copy is relabelled instead.
test('selectArchivable: in_progress is archivable again after staleInProgressMs (boundedness)', () => {
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 200 * HOUR }, // >7d
    { id: '2', status: 'in_progress', mtimeMs: NOW - 10 * HOUR }, // recent, active
    { id: '3', status: 'pending', mtimeMs: NOW - 200 * HOUR }, // pending bar is 30d
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectArchivable: staleInProgressMs Infinity disables the in_progress population', () => {
  const tasks = [{ id: '1', status: 'in_progress', mtimeMs: NOW - 10_000 * HOUR }];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0, staleInProgressMs: Infinity }), []);
});

test('archiveCopyFor: relabels an in_progress task to pending, clears owner, leaves a breadcrumb', () => {
  const { task, relabelled } = archiveCopyFor(
    { id: '1', status: 'in_progress', subject: 'x', owner: { session: 'dead' }, custom: 'keep me' },
    { now: NOW, idleMs: 9 * 24 * HOUR });
  assert.equal(relabelled, true);
  assert.equal(task.status, 'pending', 'the archived record must stop claiming work is underway');
  assert.equal(task.owner, null, 'a non-in_progress task must not still name a vanished owner');
  assert.equal(task.custom, 'keep me', 'every other field survives');
  assert.match(task.archivedFromInProgressReason, /no activity for 9d while in_progress/);
  assert.ok(task.archivedFromInProgressAt);
});

test('archiveCopyFor: every other status is returned untouched and unrelabelled', () => {
  for (const status of ['completed', 'pending', 'cancelled']) {
    const input = { id: '1', status, owner: { session: 's' } };
    const { task, relabelled } = archiveCopyFor(input, { now: NOW });
    assert.equal(relabelled, false);
    assert.equal(task, input, 'archival of other statuses stays a byte-for-byte move');
  }
});

test('archiveCopyFor: null/garbage input never throws', () => {
  assert.deepEqual(archiveCopyFor(null, { now: NOW }), { task: null, relabelled: false });
});

test('archiveCompletedTasks: move-time recheck uses fresh fs.statSync, not the scan snapshot (race guard)', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'pending' }, 40 * 24); // >30d pending bar
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

test('selectArchivable: picks pending tasks untouched longer than pendingMaxAgeMs (card #1351)', () => {
  const tasks = [
    { id: '1', status: 'pending', subject: 'Old pending card', mtimeMs: NOW - 40 * 24 * HOUR }, // >30d
    { id: '2', status: 'pending', subject: 'Recent pending card', mtimeMs: NOW - 5 * 24 * HOUR }, // fresh
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectArchivable: pendingMaxAgeMs: Infinity disables the pending population entirely', () => {
  const tasks = [
    { id: '1', status: 'pending', subject: 'Old pending card', mtimeMs: NOW - 10_000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0, pendingMaxAgeMs: Infinity }), []);
});

test('selectArchivable: ages out "BSC Daily:" pending tasks on the shorter bscDailyMaxAgeMs clock', () => {
  const tasks = [
    { id: '1', status: 'pending', subject: 'BSC Daily: 2026-08-01 digest', mtimeMs: NOW - 10 * 24 * HOUR }, // >7d, <30d
    { id: '2', status: 'pending', subject: 'BSC Daily: 2026-08-10 digest', mtimeMs: NOW - 2 * 24 * HOUR }, // <7d, stays
    { id: '3', status: 'pending', subject: 'Not a digest card', mtimeMs: NOW - 10 * 24 * HOUR }, // ordinary pending, <30d, stays
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectArchivable: bscDailyMaxAgeMs: Infinity disables the BSC-Daily population entirely', () => {
  const tasks = [
    { id: '1', status: 'pending', subject: 'BSC Daily: ancient digest', mtimeMs: NOW - 10_000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0, bscDailyMaxAgeMs: Infinity }), []);
});

test('selectArchivable: pending populations still respect the keepTopN frontier', () => {
  const tasks = [
    { id: '10', status: 'pending', subject: 'Old pending card', mtimeMs: NOW - 1000 * HOUR },
    { id: '11', status: 'pending', subject: 'BSC Daily: old digest', mtimeMs: NOW - 1000 * HOUR },
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 1 }), ['10']);
});

test('archiveCompletedTasks: archives a stale pending task and a stale BSC Daily card end-to-end', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'pending', subject: 'Old pending card' }, 40 * 24);
  writeTask(dir, 2, { status: 'pending', subject: 'BSC Daily: old digest' }, 10 * 24);
  writeTask(dir, 3, { status: 'pending', subject: 'Recent pending card' }, 1);
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, ['1', '2']);
  assert.equal(fs.existsSync(path.join(dir, '1.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '2.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '3.json')), true);
});

test('archiveCompletedTasks: pending move-time recheck skips a task touched again since scan', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'pending', subject: 'Old pending card' }, 40 * 24);
  const livePath = path.join(dir, '1.json');
  const origStat = fs.statSync;
  let calls = 0;
  fs.statSync = (p, ...rest) => {
    if (p === livePath) {
      calls += 1;
      if (calls === 2) { // second stat = the move-time recheck (first is the scan in loadTasksWithMtime)
        const fresh = new Date(NOW);
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

test('archiveCompletedTasks: archives a stale in_progress orphan with the copy RELABELLED to pending', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'dead session claim', owner: { session: 'gone' } }, 200);
  writeTask(dir, 2, { status: 'in_progress' }, 1); // fresh, must stay live
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, ['1']);
  assert.deepEqual(result.relabelled, ['1']);
  // Live file is GONE (boundedness) and was never rewritten on its way out.
  assert.equal(fs.existsSync(path.join(dir, '1.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '2.json')), true);
  const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', '1.json'), 'utf8'));
  assert.equal(archived.status, 'pending', 'THE FIX: the archived record must not claim in_progress');
  assert.equal(archived.owner, null);
  assert.equal(archived.subject, 'dead session claim', 'no other field is lost');
  assert.ok(archived.archivedFromInProgressAt);
  // The fresh one is untouched.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '2.json'), 'utf8')).status, 'in_progress');
});

test('archiveCompletedTasks: a completed task is still archived byte-for-byte (no relabel creep)', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'completed', subject: 'done thing' }, 200);
  const raw = fs.readFileSync(path.join(dir, '1.json'), 'utf8');
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, ['1']);
  assert.deepEqual(result.relabelled, []);
  assert.equal(fs.readFileSync(path.join(dir, 'archive', '1.json'), 'utf8'), raw);
});

test('archiveCompletedTasks: NO live task file is ever rewritten (only unlinked)', () => {
  // This is the property that makes the relabel safe without any of
  // sweepUntrackedInProgress's live-flip guards. Assert it structurally.
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'a' }, 200);
  writeTask(dir, 2, { status: 'in_progress', subject: 'fresh' }, 1);
  const writes = [];
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => { writes.push(String(p)); return origWrite(p, ...rest); };
  try {
    archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  } finally {
    fs.writeFileSync = origWrite;
  }
  const liveWrites = writes.filter((w) => !w.includes(`${path.sep}archive${path.sep}`) && /\d+\.json/.test(w));
  assert.deepEqual(liveWrites, [], `no write may target a live task file, got ${JSON.stringify(liveWrites)}`);
});
