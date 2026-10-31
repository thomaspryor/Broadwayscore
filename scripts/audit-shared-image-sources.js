#!/usr/bin/env node
/**
 * audit-shared-image-sources.js
 *
 * BRO-4996: lists every image source URL that data/image-sources.json records
 * for two or more live show rows that are not the same production (no transfer
 * or tour link, not in ALLOWED_SHARED_IMAGES), plus
 * known placeholder sources in use. Each one means a row shows another show's
 * art. Fix: null the wrong row's images and add the source to its
 * rejectedImageUrls; or, when its file is right and only the record is stale,
 * record "manual:<note>" for it.
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/audit-shared-image-sources.js [--json] [--strict]
 *     --strict   exit 1 when any source is shared (default: always exit 0)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findSharedSources } = require('./lib/shared-image-source');
const { loadImageSources } = require('./lib/image-sources-store');
const { hasHelpFlag } = require('./lib/cli-help.js');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function main(args) {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const found = findSharedSources(loadImageSources(), shows);
  const rows = new Set(found.flatMap((f) => f.ids));
  if (args.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else {
    console.log(`${found.length} shared or placeholder image source(s) across ${rows.size} show row(s)`);
    for (const f of found) console.log(`  ${f.placeholder ? '[placeholder] ' : ''}${f.source}\n    ${f.ids.join(', ')}`);
  }
  return args.includes('--strict') && found.length ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/audit-shared-image-sources.js [--json] [--strict]');
    process.exit(0);
  }
  process.exit(main(args));
}

module.exports = { main };
