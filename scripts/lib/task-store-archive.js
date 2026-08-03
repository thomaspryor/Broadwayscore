/**
 * Task-store archiver — moves long-completed tasks AND stale in_progress
 * orphans out of the live ~/.claude/tasks/<list>/ directory into a sibling
 * archive/ subdirectory, so the harness's injected task-list reminder (one
 * line per file in the live directory, ~860 lines / avg 16x per session per
 * the 5-day audit) shrinks to just pending/active/recently-completed work.
 *
 * ID-COLLISION SAFETY (card #854 design review P0): the harness's own
 * next-id allocator (mirrored in notion-tasks-sync.js's nextId()) computes
 * `Math.max(highwatermark, maxFileIdInLiveDir + 1)`. Live-tested against
 * the real store 2026-08-02: creating a task, then removing that exact
 * task's file, then creating another task reused the freed id — the
 * highwatermark file lags behind live creations and does not by itself
 * prevent reuse. Removing a file that WAS the live directory's max id is
 * therefore unsafe. selectArchivable() guards this by refusing to select
 * any of the `keepTopN` highest-id files present, regardless of age or
 * status — old completed/stale-in_progress tasks (the only archive
 * candidates) are always far below the current id frontier in practice, so
 * this costs nothing.
 *
 * Task JSON carries no completion timestamp (checked: real corpus has
 * none), so "completed >24h ago" is judged off the file's own mtime — the
 * last write is the status flip to completed in the overwhelming common
 * case. Same reasoning applies to "in_progress, untouched >7d": mtime is
 * the last status-flip-to-in_progress or owner-claim write.
 *
 * Card #955 (token-cost hunt round 2): threshold tightened 48h -> 24h for
 * completed tasks, and a second population (stale in_progress orphans —
 * sessions that died without ever flipping status) added. Both keep the
 * S1 union-loader contract: archived tasks remain point-lookupable via
 * readArchivedTask()/mergeWithArchive() from bsc-next.js,
 * notion-tasks-sync.js, and workspace-mark-done.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // tightened from 48h — card #955, hunt item 1
const DEFAULT_KEEP_TOP_N = 50; // safety margin — see module docstring
const DEFAULT_STALE_IN_PROGRESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days untouched

/**
 * Pure selection: which tasks are safe + eligible to archive.
 *
 * Two independent populations are eligible, unioned:
 *   1. completed tasks older than maxAgeMs (the original S1 #854 lever).
 *   2. in_progress tasks untouched for longer than staleInProgressMs — the
 *      dispatching session died or was abandoned without ever flipping
 *      status, so the task sits in the live (harness-injected-reminder)
 *      directory forever otherwise. Card #955 hunt item 1: "consider
 *      archiving in_progress-orphans". `owner` is NOT used as a signal —
 *      empirically most in_progress tasks never get an owner set (102/107
 *      on 2026-08-03), so absence of owner is not evidence of staleness;
 *      only mtime age is.
 *
 * @param {Array<{id: string, status: string, mtimeMs: number}>} tasks
 * @param {object} opts
 * @param {number} opts.now - Date.now()-equivalent, injected for testability
 * @param {number} [opts.maxAgeMs]
 * @param {number} [opts.keepTopN]
 * @param {number} [opts.staleInProgressMs] - set to Infinity to disable this population
 * @returns {string[]} ids selected for archival, ascending
 */
function selectArchivable(tasks, {
  now, maxAgeMs = DEFAULT_MAX_AGE_MS, keepTopN = DEFAULT_KEEP_TOP_N,
  staleInProgressMs = DEFAULT_STALE_IN_PROGRESS_MS,
}) {
  const byIdDesc = [...tasks].sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
  const frontier = new Set(byIdDesc.slice(0, keepTopN).map((t) => t.id));
  const eligible = (t) => {
    if (frontier.has(t.id)) return false;
    if (typeof t.mtimeMs !== 'number') return false;
    if (t.status === 'completed') return now - t.mtimeMs > maxAgeMs;
    if (t.status === 'in_progress') return now - t.mtimeMs > staleInProgressMs;
    return false;
  };
  return tasks
    .filter(eligible)
    .map((t) => t.id)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Load every `<id>.json` in dir with its parsed content + mtime. Skips unparseable files. */
function loadTasksWithMtime(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    const p = path.join(dir, f);
    let stat, data;
    try { stat = fs.statSync(p); } catch { continue; }
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    out.push({ ...data, mtimeMs: stat.mtimeMs });
  }
  return out;
}

// Minimal mkdir-based advisory lock, mirroring json-write-guard.js's
// acquireLock/releaseLock shape (not imported — that module is scoped to
// single-file JSON writes with a snapshot/merge contract this directory
// archiver doesn't need; duplicating the small lock primitive is cheaper
// and safer than bolting an unrelated shape onto a shared file).
// Advisory only: it serializes concurrent runs of THIS script, not the
// harness's own TaskCreate/TaskUpdate — those are protected by never
// touching the id frontier (see selectArchivable) and by the archive-then-
// delete ordering in archiveCompletedTasks below.
const LOCK_STALE_MS = 5 * 60 * 1000;

function acquireArchiveLock(dir) {
  const lockDir = path.join(dir, '.archive-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        stale = Date.now() - Date.parse(owner.acquiredAt) > LOCK_STALE_MS;
      } catch { stale = true; } // unreadable owner.json — a crashed writer, not a live one
      if (stale) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* retry loop handles it */ } continue; }
      if (Date.now() > deadline) throw new Error(`task-store-archive: timed out waiting for lock at ${lockDir}`);
    }
  }
}

/**
 * Archive selected ids: write full content to archive/<id>.json (verified
 * by read-back), THEN delete the live copy. Never deletes before the
 * archive copy is confirmed on disk, so a crash mid-run leaves a task
 * live-and-duplicated (harmless — the union loaders in bsc-next.js /
 * workspace-mark-done.js / notion-tasks-sync.js dedupe by id, live wins)
 * rather than lost.
 *
 * @param {string} dir - live tasks directory (~/.claude/tasks/<list>)
 * @param {object} [opts] - forwarded to selectArchivable; opts.now required by caller for determinism
 * @returns {{archived: string[], skipped: Array<{id:string, reason:string}>, bytesFreed: number}}
 */
function archiveCompletedTasks(dir, opts = {}) {
  const now = opts.now ?? Date.now();
  const release = acquireArchiveLock(dir);
  try {
    const tasks = loadTasksWithMtime(dir);
    const ids = selectArchivable(tasks, { ...opts, now });
    const archiveDir = path.join(dir, 'archive');
    if (ids.length && !fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    const archived = [];
    const skipped = [];
    let bytesFreed = 0;
    for (const id of ids) {
      const livePath = path.join(dir, `${id}.json`);
      const archivePath = path.join(archiveDir, `${id}.json`);
      let raw;
      try { raw = fs.readFileSync(livePath, 'utf8'); } catch { skipped.push({ id, reason: 'live file vanished mid-run' }); continue; }
      // Re-verify right before moving — a concurrent TaskUpdate could have
      // reopened this task (status) or, for the in_progress population,
      // resumed active work on it (mtime) between the initial scan and now.
      let parsed, liveStat;
      try { parsed = JSON.parse(raw); } catch { skipped.push({ id, reason: 'unparseable at move time' }); continue; }
      if (!['completed', 'in_progress'].includes(parsed.status)) { skipped.push({ id, reason: `status changed to ${parsed.status}` }); continue; }
      if (parsed.status === 'in_progress') {
        try { liveStat = fs.statSync(livePath); } catch { skipped.push({ id, reason: 'live file vanished mid-run' }); continue; }
        const staleMs = opts.staleInProgressMs ?? DEFAULT_STALE_IN_PROGRESS_MS;
        if (now - liveStat.mtimeMs <= staleMs) { skipped.push({ id, reason: 'in_progress task touched again since scan — no longer stale' }); continue; }
      }

      const tmp = `${archivePath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, raw);
      fs.renameSync(tmp, archivePath);
      const readBack = fs.readFileSync(archivePath, 'utf8');
      if (readBack !== raw) { skipped.push({ id, reason: 'archive read-back mismatch — live copy kept' }); continue; }

      const sizeBefore = fs.statSync(livePath).size;
      fs.unlinkSync(livePath);
      bytesFreed += sizeBefore;
      archived.push(id);
    }
    return { archived, skipped, bytesFreed };
  } finally {
    release();
  }
}

/** Read a single archived task by id, or null. Cheap point lookup — no directory scan. */
function readArchivedTask(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'archive', `${id}.json`), 'utf8')); }
  catch { return null; }
}

/**
 * Merge a live-dir task array with every task under archive/, live wins on
 * id collision (shouldn't happen — archival deletes the live copy — but a
 * crash-interrupted run per archiveCompletedTasks's docstring can leave
 * both, and live is always the freshest). Shared by bsc-next.js and
 * notion-tasks-sync.js (same repo, same directory contract); workspace-
 * mark-done.js (~/.claude/hooks, a separate repo) duplicates this
 * intentionally rather than cross-repo-require — same precedent as
 * AUTO_PROJECTS/cleanTitle already documented there.
 */
function mergeWithArchive(dir, liveTasks) {
  const archiveDir = path.join(dir, 'archive');
  let archiveFiles;
  try { archiveFiles = fs.readdirSync(archiveDir); } catch { return liveTasks; }
  const liveIds = new Set(liveTasks.map((t) => t.id));
  const archived = archiveFiles
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .filter((t) => !liveIds.has(t.id));
  return [...liveTasks, ...archived];
}

module.exports = {
  selectArchivable,
  loadTasksWithMtime,
  archiveCompletedTasks,
  readArchivedTask,
  mergeWithArchive,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_KEEP_TOP_N,
};
