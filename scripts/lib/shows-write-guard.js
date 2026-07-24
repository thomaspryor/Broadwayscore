/**
 * Single choke point for reading and writing data/shows.json.
 *
 * Problem: 50+ scripts each do their own `JSON.parse(fs.readFileSync(...))`
 * then `fs.writeFileSync(...)` on data/shows.json, with no coordination. Two
 * scripts running concurrently (locally, or a local run overlapping a cron)
 * can both load the file, both mutate their own in-memory copy, and the
 * second one to save clobbers whatever the first one wrote — including
 * fields the first writer never touched. Caught in the wild 2026-04-30 (see
 * card notes) when enrich-off-broadway-dates.js's saveShows() was seconds
 * away from silently overwriting a manually-committed priorRuns fixture.
 *
 * Fix, three parts:
 *   1. An advisory file lock (mkdir-based — atomic on POSIX, no dependency)
 *      serializes writers so no write is ever torn or interleaved.
 *   2. A re-read-and-merge-by-id step: saveShows() re-reads shows.json AFTER
 *      acquiring the lock, diffs the caller's data against the snapshot it
 *      loaded (tracked by object identity), and applies just the caller's
 *      added/changed/removed show entries on top of the fresh file — so a
 *      concurrent writer's changes to OTHER shows survive.
 *   3. The actual write goes through atomic-shows-write.js (rename-based,
 *      symlink-safe, refuses a >5% line-count shrink) rather than a bare
 *      writeFileSync — that module already covers half-write corruption
 *      and accidental mass-deletion; this one adds the missing lock+merge
 *      layer its own docstring flagged as still unaddressed ("this helper
 *      only protects against half-write corruption, not concurrent
 *      writers").
 *
 * Usage (drop-in replacement for the loadShows/saveShows pair every script
 * already defines locally):
 *   const { loadShows, saveShows } = require('./lib/shows-write-guard');
 *   const data = loadShows();
 *   data.shows.find(s => s.id === id).status = 'open';
 *   saveShows(data);
 *
 * Merge is whole-show-object granularity keyed by `id`, not field-level: if
 * two concurrent writers both touch the SAME show, the second save wins for
 * that show (still no worse than before). Different shows never collide.
 * The merge only fires when `data` is the exact object `loadShows()`
 * returned (or a value derived by mutating it in place) — the common
 * pattern in every caller in this codebase. If a script builds a fresh
 * object instead (no snapshot found), saveShows() still takes the lock and
 * writes safely, just without merge — no worse than the pre-lock behavior.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteShowsJson } = require('./atomic-shows-write');

const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');
const LOCK_STALE_MS = 60_000; // a single save should never legitimately hold this long
const LOCK_POLL_MS = 100;
const LOCK_MAX_WAIT_MS = 30_000;

function readShowsRaw(showsPath) {
  return JSON.parse(fs.readFileSync(showsPath, 'utf8'));
}

/** Synchronous sleep without burning CPU in a spin loop. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        lockOwnerPath(lockDir),
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })
      );
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Break a stale lock (crashed holder never released it).
      try {
        const stat = fs.statSync(lockOwnerPath(lockDir));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue; // retry immediately, no sleep
        }
      } catch {
        // owner.json missing/racing with another acquirer's mkdir — fall
        // through to the wait below instead of treating this as stale.
      }

      if (Date.now() > deadline) {
        throw new Error(
          `shows-write-guard: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for lock at ${lockDir}`
        );
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/** Deep-enough equality for show objects — JSON round-trip is fine, they're plain data. */
function sameShow(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge this caller's changes (relative to `snapshot`, what loadShows() gave
 * them) onto `fresh` (what's on disk right now). Whole-show granularity,
 * keyed by id. Ordering favors fresh's existing order, then appends
 * genuinely new shows.
 */
function mergeShows(snapshot, mutated, fresh) {
  const snapshotById = new Map(snapshot.shows.map((s) => [s.id, s]));
  const mutatedById = new Map(mutated.shows.map((s) => [s.id, s]));
  const freshById = new Map(fresh.shows.map((s) => [s.id, s]));

  const removedIds = new Set();
  for (const id of snapshotById.keys()) {
    if (!mutatedById.has(id)) removedIds.add(id);
  }

  const changedOrAddedIds = new Set();
  for (const [id, show] of mutatedById) {
    const orig = snapshotById.get(id);
    if (!orig || !sameShow(orig, show)) changedOrAddedIds.add(id);
  }

  const mergedById = new Map(freshById);
  for (const id of changedOrAddedIds) mergedById.set(id, mutatedById.get(id));
  for (const id of removedIds) mergedById.delete(id);

  const order = fresh.shows.map((s) => s.id);
  for (const id of mergedById.keys()) {
    if (!order.includes(id)) order.push(id);
  }

  return order.filter((id) => mergedById.has(id)).map((id) => mergedById.get(id));
}

/**
 * Build a loadShows/saveShows pair bound to a specific shows.json path.
 * The default export below is this, bound to the real data/shows.json —
 * tests use this factory directly to point at a throwaway fixture file
 * instead (real concurrent-writer simulation needs an isolated file).
 */
function createShowsWriteGuard(showsPath) {
  const lockDir = `${showsPath}.lock`;
  // Tracks the as-loaded snapshot for each object loadShows() has handed
  // out, so saveShows() can tell what THIS caller actually changed.
  const snapshots = new WeakMap();

  /**
   * Load shows.json. Snapshots the parsed result so a later saveShows()
   * call with this same object (or one derived by mutating it) can merge
   * cleanly instead of clobbering concurrent writers.
   */
  function loadShows() {
    const data = readShowsRaw(showsPath);
    snapshots.set(data, JSON.parse(JSON.stringify(data)));
    return data;
  }

  /**
   * Save shows.json under an exclusive lock. Re-reads the file after
   * acquiring the lock and merges this caller's changes onto whatever's
   * current, by show id, before writing.
   *
   * @param {object} data - The shows.json object (as returned by loadShows()).
   * @param {object} [options]
   * @param {boolean} [options.allowShrink] - Forwarded to atomicWriteShowsJson;
   *   pass when the caller is deliberately deleting shows.
   */
  function saveShows(data, options = {}) {
    acquireLock(lockDir);
    try {
      const snapshot = snapshots.get(data);
      let finalData = data;

      if (snapshot) {
        const fresh = readShowsRaw(showsPath);
        const freshChanged =
          fresh.shows.length !== snapshot.shows.length ||
          JSON.stringify(fresh.shows.map((s) => s.id)) !== JSON.stringify(snapshot.shows.map((s) => s.id)) ||
          fresh.shows.some((s, i) => !sameShow(s, snapshot.shows[i]));

        if (freshChanged) {
          finalData = {
            ...fresh,
            ...(data._meta ? { _meta: { ...fresh._meta, ...data._meta } } : {}),
            shows: mergeShows(snapshot, data, fresh),
          };
        }
      }

      finalData._meta = finalData._meta || {};
      finalData._meta.lastUpdated = new Date().toISOString();
      finalData._meta.totalShows = finalData.shows.length;

      const result = atomicWriteShowsJson(showsPath, finalData, options);
      snapshots.set(data, JSON.parse(JSON.stringify(finalData)));
      return result;
    } finally {
      releaseLock(lockDir);
    }
  }

  return { loadShows, saveShows, showsPath, lockDir };
}

const defaultGuard = createShowsWriteGuard(SHOWS_PATH);

module.exports = {
  SHOWS_PATH,
  loadShows: defaultGuard.loadShows,
  saveShows: defaultGuard.saveShows,
  // Exposed for tests:
  createShowsWriteGuard,
  mergeShows,
  LOCK_DIR: defaultGuard.lockDir,
};
