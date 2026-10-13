#!/usr/bin/env node
// Find a memory note in cloud-memory/ by keyword, or list them all (BRO-2556).
//   node scripts/cloud-memory-search.js grinch poster   -> notes matching ALL terms
//   node scripts/cloud-memory-search.js                 -> every note, one line each
const path = require('path');
const { buildIndex, searchIndex, formatEntry } = require('./lib/cloud-memory-index');

const dir = process.env.CLOUD_MEMORY_DIR || path.join(__dirname, '..', 'cloud-memory');
const entries = buildIndex(dir);
const hits = process.argv.length > 2 ? searchIndex(entries, process.argv.slice(2)) : entries;
for (const e of hits) console.log(formatEntry(e));
console.error(`${hits.length} of ${entries.length} notes (open one with: cat cloud-memory/<file>)`);
process.exit(hits.length ? 0 : 1);
