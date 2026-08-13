import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectArchivable, selectReclaimableInProgress, loadTasksWithMtime, archiveCompletedTasks,
  readArchivedTask, mergeWithArchive,
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

// The in_progress population moved OUT of selectArchivable and into
// selectReclaimableInProgress. Card #955 originally archived these directly;
// that created the two-timer deadlock measured 2026-08-12 (86 of 146
// in_progress records permanently stuck, because the only thing that would
// flip them back — sweepUntrackedInProgress — reads the live dir only). These
// tests now assert the inverse property: archival must NEVER claim an
// in_progress task, at any age.
test('selectArchivable: NEVER archives an in_progress task, however stale (deadlock guard)', () => {
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 200 * HOUR }, // >7d
    { id: '2', status: 'in_progress', mtimeMs: NOW - 10_000 * HOUR }, // absurdly stale
    { id: '3', status: 'pending', mtimeMs: NOW - 200 * HOUR }, // pending: not stale enough (30d bar)
  ];
  assert.deepEqual(selectArchivable(tasks, { now: NOW, keepTopN: 0 }), []);
});

test('selectReclaimableInProgress: picks in_progress tasks untouched longer than staleInProgressMs', () => {
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 200 * HOUR }, // >7d
    { id: '2', status: 'in_progress', mtimeMs: NOW - 10 * HOUR }, // recent, active
    { id: '3', status: 'pending', mtimeMs: NOW - 200 * HOUR }, // wrong status
    { id: '4', status: 'completed', mtimeMs: NOW - 200 * HOUR }, // wrong status
  ];
  assert.deepEqual(selectReclaimableInProgress(tasks, { now: NOW, keepTopN: 0 }), ['1']);
});

test('selectReclaimableInProgress: staleInProgressMs: Infinity disables reclaim entirely', () => {
  const tasks = [{ id: '1', status: 'in_progress', mtimeMs: NOW - 10_000 * HOUR }];
  assert.deepEqual(selectReclaimableInProgress(tasks, { now: NOW, keepTopN: 0, staleInProgressMs: Infinity }), []);
});

test('selectReclaimableInProgress: respects the keepTopN frontier', () => {
  const tasks = [
    { id: '10', status: 'in_progress', mtimeMs: NOW - 1000 * HOUR },
    { id: '11', status: 'in_progress', mtimeMs: NOW - 1000 * HOUR },
  ];
  assert.deepEqual(selectReclaimableInProgress(tasks, { now: NOW, keepTopN: 1 }), ['10']);
});

test('selectReclaimableInProgress: ignores tasks with no usable mtime', () => {
  const tasks = [{ id: '1', status: 'in_progress' }, { id: '2', status: 'in_progress', mtimeMs: null }];
  assert.deepEqual(selectReclaimableInProgress(tasks, { now: NOW, keepTopN: 0 }), []);
});

// Fixture is `pending`, not `in_progress`: in_progress is no longer an archival
// population at all (deadlock fix), so an in_progress fixture would exercise the
// reclaim path instead of the archival move-time recheck this test is about.
// `pending` is the surviving population that still carries an mtime recheck.
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

// The reclaim WRITE pass is default-off (see archiveCompletedTasks). Tests that
// exercise it pass reclaimEnabled explicitly so they don't depend on ambient env.
test('archiveCompletedTasks: reclaim is OFF by default — an in_progress orphan is neither archived nor rewritten', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'dead session claim' }, 200);
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0 });
  assert.deepEqual(result.archived, [], 'still must never archive an in_progress task');
  assert.deepEqual(result.reclaimed, [], 'the write pass must not fire without TASK_RECLAIM_ENABLED');
  const untouched = JSON.parse(fs.readFileSync(path.join(dir, '1.json'), 'utf8'));
  assert.equal(untouched.status, 'in_progress');
  assert.equal(untouched.inProgressReclaimedAt, undefined);
});

test('selectArchivable and selectReclaimableInProgress are DISJOINT on any input (no same-run double handling)', () => {
  // Codex P2: relying on run-ordering alone is fragile. Assert the sets can
  // never overlap, so re-adding in_progress eligibility to selectArchivable
  // fails here instead of silently reclaiming-then-archiving the same task.
  const tasks = [
    { id: '1', status: 'in_progress', mtimeMs: NOW - 200 * HOUR },
    { id: '2', status: 'in_progress', mtimeMs: NOW - 10_000 * HOUR },
    { id: '3', status: 'completed', mtimeMs: NOW - 200 * HOUR },
    { id: '4', status: 'pending', mtimeMs: NOW - 10_000 * HOUR },
    { id: '5', status: 'pending', subject: 'BSC Daily: x', mtimeMs: NOW - 400 * HOUR },
  ];
  const a = new Set(selectArchivable(tasks, { now: NOW, keepTopN: 0 }));
  const r = selectReclaimableInProgress(tasks, { now: NOW, keepTopN: 0 });
  assert.ok(r.length > 0, 'fixture must actually produce reclaim candidates');
  for (const id of r) assert.ok(!a.has(id), `#${id} is in BOTH populations — reclaim and archive would both fire`);
});

test('archiveCompletedTasks: RECLAIMS a stale in_progress orphan to pending end-to-end, never archives it', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'dead session claim' }, 200);
  writeTask(dir, 2, { status: 'in_progress' }, 1); // fresh, must stay in_progress
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0, reclaimEnabled: true });
  assert.deepEqual(result.archived, [], 'an in_progress task must never be archived');
  assert.deepEqual(result.reclaimed, ['1']);
  // Stays LIVE — that is the whole point. Archiving it while in_progress is
  // what made 86 tasks permanently unreachable (see the module docstring).
  assert.equal(fs.existsSync(path.join(dir, '1.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'archive', '1.json')), false);
  const reclaimed = JSON.parse(fs.readFileSync(path.join(dir, '1.json'), 'utf8'));
  assert.equal(reclaimed.status, 'pending');
  assert.equal(reclaimed.subject, 'dead session claim', 'reclaim must not lose any other field');
  assert.ok(reclaimed.inProgressReclaimedAt, 'reclaim must leave a breadcrumb, not flip silently');
  assert.match(reclaimed.inProgressReclaimReason, /no activity for \d+d while in_progress/);
  // The fresh one is untouched in both status and content.
  const fresh = JSON.parse(fs.readFileSync(path.join(dir, '2.json'), 'utf8'));
  assert.equal(fresh.status, 'in_progress');
  assert.equal(fresh.inProgressReclaimedAt, undefined);
});

test('archiveCompletedTasks: a reclaimed task is NOT archived in the same run (gets a full cycle back in the pool)', () => {
  const dir = mkTmp();
  // Old enough to blow past BOTH the 7d in_progress bar and the 30d pending
  // bar, so only run-ordering keeps it out of the archive this pass.
  writeTask(dir, 1, { status: 'in_progress', subject: 'ancient claim' }, 24 * 90);
  const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0, reclaimEnabled: true });
  assert.deepEqual(result.reclaimed, ['1']);
  assert.deepEqual(result.archived, [], 'reclaim-then-archive in one pass would defeat the fix');
  assert.equal(fs.existsSync(path.join(dir, '1.json')), true);
});

test('reclaim MERGES onto current disk content — a concurrent field update is not clobbered', () => {
  // Codex P0: the old shape read the file during the scan and wrote
  // {...thatRead, status:'pending'}, so any TaskUpdate landing in between was
  // silently reverted. The archiver's lock does not cover TaskUpdate.
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'original' }, 200);
  const livePath = path.join(dir, '1.json');
  // Simulate another session updating a DIFFERENT field after the scan read but
  // before the write, by patching readFileSync for the second read only.
  const origRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (p === livePath && ++reads === 2) {
      const cur = JSON.parse(origRead(p, 'utf8'));
      return JSON.stringify({ ...cur, owner: 'another-session', subject: 'updated by peer' });
    }
    return origRead(p, ...rest);
  };
  try {
    const result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0, reclaimEnabled: true });
    assert.deepEqual(result.reclaimed, ['1']);
  } finally {
    fs.readFileSync = origRead;
  }
  const after = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  assert.equal(after.status, 'pending', 'the flip must still happen');
  assert.equal(after.subject, 'updated by peer', 'the concurrent update must survive the reclaim');
  assert.equal(after.owner, 'another-session', 'fields written after our scan must not be reverted');
});

test('reclaim abandons the write if the file changes between re-read and rename (mtime CAS)', () => {
  const dir = mkTmp();
  writeTask(dir, 1, { status: 'in_progress', subject: 'racy' }, 200);
  const livePath = path.join(dir, '1.json');
  const origStat = fs.statSync;
  let stats = 0;
  fs.statSync = (p, ...rest) => {
    const s = origStat(p, ...rest);
    // The CAS stat is the last one taken on the live path; report a different
    // mtime there to simulate a peer write landing mid-reclaim.
    if (p === livePath && ++stats >= 3) return { ...s, mtimeMs: s.mtimeMs + 5000 };
    return s;
  };
  let result;
  try {
    result = archiveCompletedTasks(dir, { now: NOW, keepTopN: 0, reclaimEnabled: true });
  } finally {
    fs.statSync = origStat;
  }
  assert.deepEqual(result.reclaimed, [], 'must not claim a reclaim it abandoned');
  assert.ok(result.skipped.some((s) => s.id === '1' && /changed mid-reclaim/.test(s.reason)),
    `expected a mid-reclaim skip, got ${JSON.stringify(result.skipped)}`);
  const after = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  assert.equal(after.status, 'in_progress', 'the file must be left exactly as found');
  // No .tmp litter left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});
