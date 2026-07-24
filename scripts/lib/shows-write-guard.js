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
 * This is now a thin wrapper around the file-shape-agnostic factory in
 * json-write-guard.js — shows.json's `{ shows: [{id, ...}] }` array shape
 * was generalized to also cover commercial.json/audience-buzz.json's
 * `{ shows: { [id]: {...} } }` map shape (see commercial-write-guard.js /
 * audience-buzz-write-guard.js and json-write-guard.js's own docstring).
 * The only shows.json-specific behavior kept here is stamping
 * `_meta.totalShows` on every save, which nothing else needs.
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

const path = require('path');
const { createJsonWriteGuard, mergeArrayRecords } = require('./json-write-guard');

const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

/**
 * Build a loadShows/saveShows pair bound to a specific shows.json path.
 * The default export below is this, bound to the real data/shows.json —
 * tests use this factory directly to point at a throwaway fixture file
 * instead (real concurrent-writer simulation needs an isolated file).
 */
function createShowsWriteGuard(showsPath) {
  const guard = createJsonWriteGuard(showsPath, {
    recordsKey: 'shows',
    shape: 'array',
    idKey: 'id',
    metaKey: '_meta',
    beforeWrite: (finalData) => {
      finalData._meta.totalShows = finalData.shows.length;
    },
  });

  return {
    loadShows: guard.load,
    saveShows: guard.save,
    showsPath: guard.filePath,
    lockDir: guard.lockDir,
  };
}

/** Back-compat wrapper: old call signature was `mergeShows(snapshot, mutated, fresh)`. */
function mergeShows(snapshot, mutated, fresh) {
  return mergeArrayRecords(snapshot.shows, mutated.shows, fresh.shows, 'id');
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
