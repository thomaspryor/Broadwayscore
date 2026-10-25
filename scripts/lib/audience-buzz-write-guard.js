/**
 * Single choke point for reading and writing data/audience-buzz.json.
 *
 * Same local-concurrency gap as shows.json (see shows-write-guard.js's
 * docstring): 33 scripts each do their own fs.readFileSync/writeFileSync on
 * audience-buzz.json with no coordination — Show Score/Mezzanine/Reddit/
 * Theatr/SeatPlan/Broadway.com scrapers, shard mergers, snapshot builders —
 * so two same-machine writers can clobber each other's edits. Built on the
 * file-shape-agnostic factory in json-write-guard.js — audience-buzz.json's
 * `shows` is a MAP keyed by show id (not an array like shows.json), so this
 * uses `shape: 'map'`.
 *
 * Usage (drop-in replacement for the load/save pair every script already
 * defines locally):
 *   const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');
 *   const data = loadAudienceBuzz();
 *   data.shows['hamilton-2015'].combinedScore = 95.2;
 *   saveAudienceBuzz(data);
 *
 * Merge is whole-record granularity keyed by show id: if two concurrent
 * writers both touch the SAME show, the second save wins for that show
 * (still no worse than before). Different shows never collide. Non-`shows`
 * top-level fields (`_meta`, `lastUpdated`) are preserved/merged
 * individually — a field this caller didn't touch is taken from the fresh
 * on-disk copy.
 */

const path = require('path');
const { createJsonWriteGuard } = require('./json-write-guard');

const AUDIENCE_BUZZ_PATH = path.join(__dirname, '..', '..', 'data', 'audience-buzz.json');

/**
 * Build a load/save pair bound to a specific audience-buzz.json path. Tests
 * use this factory directly to point at a throwaway fixture file.
 */
function createAudienceBuzzWriteGuard(audienceBuzzPath) {
  const guard = createJsonWriteGuard(audienceBuzzPath, {
    recordsKey: 'shows',
    shape: 'map',
    metaKey: '_meta',
  });

  return {
    loadAudienceBuzz: guard.load,
    saveAudienceBuzz: guard.save,
    audienceBuzzPath: guard.filePath,
    lockDir: guard.lockDir,
  };
}

const defaultGuard = createAudienceBuzzWriteGuard(AUDIENCE_BUZZ_PATH);

module.exports = {
  AUDIENCE_BUZZ_PATH,
  loadAudienceBuzz: defaultGuard.loadAudienceBuzz,
  saveAudienceBuzz: defaultGuard.saveAudienceBuzz,
  // Exposed for tests:
  createAudienceBuzzWriteGuard,
  LOCK_DIR: defaultGuard.lockDir,
};
