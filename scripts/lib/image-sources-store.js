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

/** The map, or {} when the file is missing or unreadable. */
function loadImageSources(file = IMAGE_SOURCES_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveImageSources(map, file = IMAGE_SOURCES_PATH) {
  fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
}

module.exports = { IMAGE_SOURCES_PATH, loadImageSources, saveImageSources };
