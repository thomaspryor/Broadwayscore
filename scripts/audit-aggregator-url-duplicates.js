#!/usr/bin/env node
/**
 * audit-aggregator-url-duplicates.js (BRO-3517)
 *
 * Duplicate-value scan for the curated showId -> aggregator page maps that
 * audit-show-score-urls.js does not cover: two shows pointing at one page
 * means one of them silently ingests the other production's reviews
 * (she-loves-me-1994 / BRO-3416). All four maps were clean on 2026-10-29, so
 * there is no baseline: any duplicate is new.
 *
 *   node scripts/audit-aggregator-url-duplicates.js            report only, exit 0
 *   node scripts/audit-aggregator-url-duplicates.js --strict   exit 1 on any duplicate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { findDuplicateValues } = require('./lib/cache-collision');

const DATA_DIR = path.join(__dirname, '../data');
const TARGETS = [
  { file: 'bww-roundup-urls.json', flat: true },
  { file: 'dtli-slug-map.json' },
  { file: 'lbo-roundup-urls.json' },
  { file: 'playbill-urls.json' },
];

// The map inside a file: `.shows` when present, else the flat top-level
// object minus `_comment`/`_meta` style keys.
function mapFor(json) {
  if (json && json.shows && typeof json.shows === 'object') return json.shows;
  return Object.fromEntries(Object.entries(json || {}).filter(([k]) => !k.startsWith('_')));
}

function scan(dataDir = DATA_DIR, targets = TARGETS) {
  const results = [];
  for (const t of targets) {
    const p = path.join(dataDir, t.file);
    if (!fs.existsSync(p)) {
      results.push({ file: t.file, entries: 0, duplicates: [], missing: true });
      continue;
    }
    const map = mapFor(JSON.parse(fs.readFileSync(p, 'utf8')));
    results.push({ file: t.file, entries: Object.keys(map).length, duplicates: findDuplicateValues(map) });
  }
  return results;
}

function main() {
  const strict = process.argv.includes('--strict');
  const results = scan();
  let bad = 0;
  for (const r of results) {
    const note = r.missing ? 'MISSING FILE' : `${r.entries} entries, ${r.duplicates.length} duplicate value(s)`;
    console.log(`${r.file}: ${note}`);
    for (const d of r.duplicates) {
      bad++;
      console.log(`  ${d.value}\n    claimed by: ${d.keys.join(', ')}`);
      if (!strict) console.log(`::warning::${r.file}: ${d.value} claimed by ${d.keys.join(', ')}`);
    }
  }
  if (strict && bad > 0) {
    console.error(`\nFAIL: ${bad} aggregator value(s) claimed by more than one show.`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { mapFor, scan, TARGETS };
