/**
 * Single choke point for reading and writing data/commercial.json.
 *
 * Same local-concurrency gap as shows.json (see shows-write-guard.js's
 * docstring): 31 scripts each do their own fs.readFileSync/writeFileSync on
 * commercial.json with no coordination, so two same-machine writers
 * (recoupment pipeline, RSS poller, manual-review flow, etc.) can clobber
 * each other's edits. Built on the file-shape-agnostic factory in
 * json-write-guard.js — commercial.json's `shows` is a MAP keyed by slug
 * (memory: feedback_commercial_slug_keys), not an array like shows.json, so
 * this uses `shape: 'map'`.
 *
 * Usage (drop-in replacement for the load/save pair every script already
 * defines locally):
 *   const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
 *   const data = loadCommercial();
 *   data.shows['hamilton'].recouped = true;
 *   saveCommercial(data);
 *
 * Merge is whole-record granularity keyed by slug: if two concurrent writers
 * both touch the SAME show, the second save wins for that show (still no
 * worse than before). Different shows never collide. Non-`shows` top-level
 * fields (`_meta`, `modelLastRun`) are preserved/merged individually — a
 * field this caller didn't touch is taken from the fresh on-disk copy.
 */

const path = require('path');
const { createJsonWriteGuard } = require('./json-write-guard');

const COMMERCIAL_PATH = path.join(__dirname, '..', '..', 'data', 'commercial.json');

/**
 * Build a load/save pair bound to a specific commercial.json path. Tests use
 * this factory directly to point at a throwaway fixture file.
 */
function createCommercialWriteGuard(commercialPath) {
  const guard = createJsonWriteGuard(commercialPath, {
    recordsKey: 'shows',
    shape: 'map',
    metaKey: '_meta',
  });

  return {
    loadCommercial: guard.load,
    saveCommercial: guard.save,
    commercialPath: guard.filePath,
    lockDir: guard.lockDir,
  };
}

const defaultGuard = createCommercialWriteGuard(COMMERCIAL_PATH);

module.exports = {
  COMMERCIAL_PATH,
  loadCommercial: defaultGuard.loadCommercial,
  saveCommercial: defaultGuard.saveCommercial,
  // Exposed for tests:
  createCommercialWriteGuard,
  LOCK_DIR: defaultGuard.lockDir,
};
