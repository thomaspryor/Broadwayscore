/**
 * The slim Broadway-house projection the Stats engine reads:
 * src/lib/stats-ui/theater-houses.json, derived from data/theater-metadata.json.
 *
 * The engine (src/lib/stats/theater-completion.ts) needs only capacity,
 * yearBuilt and formerNames; the full metadata file carries tips, images and
 * seat scores and is not shipped to the browser. The iOS app vendors the SAME
 * projection (BroadwayScorecard-app scripts/vendor-stats-lib.js, DERIVED
 * 'theater-houses.json'), and this serializer matches its byte format, so the
 * web copy and the app copy are identical files.
 *
 * Regenerate: node scripts/generate-theater-houses.js
 * Drift gate: tests/unit/stats-theater-houses-drift.test.mjs
 */

'use strict';

const path = require('path');

const METADATA_PATH = path.join(__dirname, '..', '..', 'data', 'theater-metadata.json');
const HOUSES_PATH = path.join(__dirname, '..', '..', 'src', 'lib', 'stats-ui', 'theater-houses.json');

/** @param {Record<string, any>} full parsed theater-metadata.json */
function projectTheaterHouses(full) {
  const slim = {};
  for (const [name, meta] of Object.entries(full || {})) {
    if (name.startsWith('_') || !meta || typeof meta !== 'object') continue;
    const entry = {};
    if (typeof meta.capacity === 'number') entry.capacity = meta.capacity;
    if (typeof meta.yearBuilt === 'number') entry.yearBuilt = meta.yearBuilt;
    if (Array.isArray(meta.formerNames) && meta.formerNames.length) entry.formerNames = meta.formerNames;
    slim[name] = entry;
  }
  return slim;
}

/** The exact bytes of theater-houses.json for a given metadata object. */
function serializeTheaterHouses(full) {
  return JSON.stringify(projectTheaterHouses(full), null, 2) + '\n';
}

module.exports = { METADATA_PATH, HOUSES_PATH, projectTheaterHouses, serializeTheaterHouses };
