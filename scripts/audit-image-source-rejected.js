#!/usr/bin/env node
/**
 * audit-image-source-rejected.js
 *
 * BRO-4901: lists every show field (poster/thumbnail/hero) that points at a
 * local file whose recorded source in data/image-sources.json is one of the
 * show's own rejectedImageUrls. That means either the file is wrong-production
 * art, or someone fixed the file by hand and did not update the map (the map
 * then tells the archiver to re-download the rejected art if the file goes
 * missing). Fix: clear the field, or record the real source / "manual:<note>".
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/audit-image-source-rejected.js [--json] [--strict]
 *     --strict   exit 1 when any row is found (default: always exit 0)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findRejectedSourcesInUse } = require('./lib/image-source-match');
const { loadImageSources } = require('./lib/image-sources-store');
const { hasHelpFlag } = require('./lib/cli-help.js');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function main(args) {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const rows = findRejectedSourcesInUse(shows, loadImageSources());
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${rows.length} in-use image field(s) whose recorded source is a rejected URL`);
    for (const r of rows) console.log(`  ${r.id}.${r.format}: ${r.path} <- ${r.source}`);
  }
  return args.includes('--strict') && rows.length ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/audit-image-source-rejected.js [--json] [--strict]');
    process.exit(0);
  }
  process.exit(main(args));
}
