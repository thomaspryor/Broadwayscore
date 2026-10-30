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
 * Shows-specific invariants are applied after merging, before every write.
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
const { createJsonWriteGuard, mergeArrayRecords } = require('./json-write-guard');
const { syncStaleTheaterAddresses } = require('./venue-address-sync');
const { restoreHumanCorrectedOpeningDates } = require('./opening-date-guard');
const { sanitizeVenueForWrite } = require('./venue-classification');

const { hasStoredStaleUpcomingTag, stripUpcomingTag } = require('./opening-night-completeness');
const { newDuplicateFindings, formatFinding } = require('./shows-duplicate-rule');

const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

/**
 * Drops every 'upcoming' tag (any case) from rows whose status is in
 * PAST_UPCOMING_STATUSES, in place. upcoming/announced rows are untouched.
 * @param {Object[]} shows
 * @returns {string[]} ids of rows that lost the tag
 */
function stripStaleUpcomingTags(shows) {
  const ids = [];
  for (const s of shows || []) {
    if (hasStoredStaleUpcomingTag(s) && stripUpcomingTag(s)) ids.push(s.id);
  }
  return ids;
}

/** The rows currently on disk, or [] when there is no file yet. */
function readOnDiskShows(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed && parsed.shows) ? parsed.shows : [];
}

/**
 * Build a loadShows/saveShows pair bound to a specific shows.json path.
 * The default export below is this, bound to the real data/shows.json —
 * tests use this factory directly to point at a throwaway fixture file
 * instead (real concurrent-writer simulation needs an isolated file).
 *
 * @param {string} showsPath
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - When true, saveShows() never
 *   touches disk: no lock, no re-read/merge, no write. Each call is recorded
 *   on the returned `suppressedWrites` ledger instead (`{ reason, showCount,
 *   at }`), so a caller with several write sites (validate-data.js has four
 *   auto-fix sites) can report "N writes suppressed" and which site each came
 *   from. Callers name the site via the `reason` save option, which is
 *   stripped before a real write so atomicWriteJson never sees it.
 */
function createShowsWriteGuard(showsPath, options = {}) {
  const dryRun = !!(options && options.dryRun);
  // Set per saveShows() call; save() is synchronous, so no call sees another's.
  let allowDuplicates = false;
  const guard = createJsonWriteGuard(showsPath, {
    recordsKey: 'shows',
    shape: 'array',
    idKey: 'id',
    metaKey: '_meta',
    beforeWrite: (finalData) => {
      finalData._meta.totalShows = finalData.shows.length;
      // Apply the shared venue guard after merging, so every writer and any
      // concurrent additions are covered (BRO-5579). Keep absent fields absent.
      for (const show of finalData.shows) {
        if (show.venue !== undefined) show.venue = sanitizeVenueForWrite(show.venue);
      }
      // A venue change must carry its address (BRO-5136); only provably stale
      // addresses (another known venue's canonical one) are rewritten.
      const synced = syncStaleTheaterAddresses(finalData.shows);
      // validate-data's >5 cap doubled as a tripwire for a wrong mass venue
      // edit; keep that signal loud now that the addresses follow along.
      if (synced.length) console.log(`${synced.length > 5 ? '::warning::' : ''}shows-write-guard: synced theaterAddress to venue for ${synced.length} show(s): ${synced.map((c) => `${c.id} (${c.venue})`).join(', ')}`);
      // 'upcoming' is derived from status, never stored past it (BRO-5271):
      // whichever writer flips a show to open/previews/closed, the tag cannot
      // survive the save. fix-stale-upcoming-tags.js --check stays as audit.
      const unTagged = stripStaleUpcomingTags(finalData.shows);
      if (unTagged.length) console.log(`shows-write-guard: dropped stale 'upcoming' tag from ${unTagged.length} show(s): ${unTagged.join(', ')}`);
      // A person's openingDate correction outlives every writer (BRO-4911).
      const restored = restoreHumanCorrectedOpeningDates(finalData.shows);
      if (restored.length) console.log(`::warning::shows-write-guard: kept human-corrected openingDate for ${restored.map((r) => `${r.id} (${r.from} -> ${r.to})`).join(', ')}`);
      // A row the prebuild duplicate gate would fail on never reaches disk
      // (BRO-6578: one census stub blocked every Vercel build for 3h). Only
      // pairs this save creates are refused; the lock is held, so the file
      // read here is the state being replaced.
      // Kill switch for a misfire: SHOWS_DUP_GUARD_DISABLED=true (the prebuild gate still runs).
      if (!allowDuplicates && process.env.SHOWS_DUP_GUARD_DISABLED !== 'true') {
        const added = newDuplicateFindings(() => readOnDiskShows(guard.filePath), finalData.shows);
        if (added.length) {
          throw new Error(`shows-write-guard: refusing to write ${added.length} new duplicate show row(s); the prebuild gate would fail the build:\n${added.map((f) => `  - ${formatFinding(f)}`).join('\n')}\nUse the existing row instead of adding one; for a genuinely distinct production list the other id in the row's distinctFrom.`);
        }
      }
    },
  });

  // Dry-run ledger: one entry per saveShows() call that was swallowed.
  const suppressedWrites = [];

  /**
   * @param {object} data - The file's object, as returned by loadShows().
   * @param {object} [saveOptions]
   * @param {string} [saveOptions.reason] - Which validator/site is saving.
   *   Recorded on the dry-run ledger; never forwarded to the real write.
   * @param {boolean} [saveOptions.allowDuplicates] - Skip the duplicate-row
   *   refusal for this save (a deliberate distinct production). Never forwarded.
   * @param {boolean} [saveOptions.allowShrink] - Forwarded to the real write
   *   (see json-write-guard.js save()).
   */
  function saveShows(data, saveOptions = {}) {
    const { reason, allowDuplicates: allowDup, ...writeOptions } = saveOptions || {};
    if (!dryRun) {
      allowDuplicates = !!allowDup;
      try { return guard.save(data, writeOptions); } finally { allowDuplicates = false; }
    }
    const showCount = data && Array.isArray(data.shows) ? data.shows.length : null;
    const entry = { reason: reason || null, showCount, at: new Date().toISOString() };
    suppressedWrites.push(entry);
    return { wrote: false, dryRun: true, ...entry };
  }

  return {
    loadShows: guard.load,
    saveShows,
    showsPath: guard.filePath,
    lockDir: guard.lockDir,
    dryRun,
    suppressedWrites,
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
  stripStaleUpcomingTags,
  LOCK_DIR: defaultGuard.lockDir,
};
