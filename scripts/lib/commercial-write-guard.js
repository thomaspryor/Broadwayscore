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

const fs = require('fs');
const path = require('path');
const { createJsonWriteGuard } = require('./json-write-guard');
const { canonicalDesignation } = require('./commercial-designations');
const { syncBreakevenToCost } = require('./commercial-breakeven');
const { buildShowKeyIndex, canonicalizeCommercialKeys } = require('./commercial-slug-key');

const COMMERCIAL_PATH = path.join(__dirname, '..', '..', 'data', 'commercial.json');

// shows.json next to the commercial.json being written, indexed once per
// file version (it is ~8MB; some writers save inside a loop).
const _indexCache = new Map();
function showKeyIndexFor(commercialPath) {
  const showsPath = path.join(path.dirname(commercialPath), 'shows.json');
  let stat;
  try { stat = fs.statSync(showsPath); } catch { return null; }
  const cached = _indexCache.get(showsPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;
  try {
    const index = buildShowKeyIndex(JSON.parse(fs.readFileSync(showsPath, 'utf8')));
    _indexCache.set(showsPath, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return index;
  } catch {
    return null;
  }
}

/**
 * Build a load/save pair bound to a specific commercial.json path. Tests use
 * this factory directly to point at a throwaway fixture file.
 */
function createCommercialWriteGuard(commercialPath) {
  const guard = createJsonWriteGuard(commercialPath, {
    recordsKey: 'shows',
    shape: 'map',
    metaKey: '_meta',
    beforeWrite: (finalData) => {
      // Every writer funnels through here, so canonicalize designation casing
      // ("flop" -> "Flop") once instead of trusting each script (BRO-4570).
      // Unknown values are left as-is for validate-data.js to reject.
      for (const rec of Object.values(finalData.shows || {})) {
        const canon = rec && canonicalDesignation(rec.designation);
        if (canon) rec.designation = canon;
        // A weekly cost changed since the last model run: scale the model's
        // break-even with it, never leave it below the cost (BRO-4985).
        syncBreakevenToCost(rec);
      }
      // BRO-4623: commercial.json is keyed by slug. A record keyed by a show
      // ID (from any writer that skipped scripts/lib/commercial-slug-key.js)
      // is moved onto its slug when that key is free; one whose slug entry
      // already exists is left for dedupe-commercial-id-keys.js, which
      // merges or refuses with the evidence printed. No shows.json beside
      // the file (test fixtures) means no-op.
      const index = showKeyIndexFor(commercialPath);
      if (index && finalData.shows) {
        const { rekeyed } = canonicalizeCommercialKeys(finalData.shows, index);
        for (const { from, to } of rekeyed) {
          console.warn(`commercial-write-guard: re-keyed commercial.json "${from}" (a show id) to its slug "${to}"`);
        }
      }
    },
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
