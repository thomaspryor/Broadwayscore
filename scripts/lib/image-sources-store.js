'use strict';
/**
 * The one reader/writer for data/image-sources.json: show id -> { poster,
 * thumbnail, hero } source of the file each format serves (a CDN URL, or
 * "manual:<note>" for a file set by hand). Every script that writes an image
 * file under public/images/shows/<id>/ records its source here, or readers
 * (mayServeDiskImage, the season audits, the archiver's re-download) act on a
 * source that no longer describes the file (BRO-4901).
 */
const fs = require('fs');
const path = require('path');

const IMAGE_SOURCES_PATH = path.join(__dirname, '..', '..', 'data', 'image-sources.json');

/**
 * The map, or {} when the file does not exist yet. A corrupt file throws:
 * loading it as {} would let the next save wipe every recorded source.
 */
function loadImageSources(file = IMAGE_SOURCES_PATH) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
}

/** Write via temp file + rename, so a kill mid-write never leaves a truncated map. */
function saveImageSources(map, file = IMAGE_SOURCES_PATH) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** One-shot: record `source` for each format of showId's own files, then save. */
function recordImageSource(showId, formats, source, file = IMAGE_SOURCES_PATH) {
  const map = loadImageSources(file);
  map[showId] = map[showId] || {};
  for (const f of formats) map[showId][f] = source;
  saveImageSources(map, file);
}

module.exports = { IMAGE_SOURCES_PATH, loadImageSources, saveImageSources, recordImageSource };
