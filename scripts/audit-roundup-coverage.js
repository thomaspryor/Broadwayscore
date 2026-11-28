#!/usr/bin/env node
/**
 * CLI wrapper for scripts/lib/roundup-coverage-check.js (BRO-155 follow-up).
 *
 * findMissingRoundupShows existed only as a library exercised by its own
 * test — no documented way to actually run it against a freshly-copied
 * editorial roundup. This gives the next session a real command instead of
 * a hand-written `node -e`.
 *
 * Usage:
 *   node scripts/audit-roundup-coverage.js --file=path/to/roundup.json
 *
 * Input file: a JSON array of {title, venue?} objects — e.g. copy-pasted
 * from a NYT/TimeOut/Vulture "shows to see" feature.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { findMissingRoundupShows } = require('./lib/roundup-coverage-check');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith('--file='))?.split('=').slice(1).join('=');

if (!fileArg) {
  console.error('Usage: node scripts/audit-roundup-coverage.js --file=path/to/roundup.json');
  console.error('Input file: JSON array of {title, venue?} objects.');
  process.exit(1);
}

const roundupEntries = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const shows = showsRaw.shows || showsRaw;

const missing = findMissingRoundupShows(roundupEntries, shows);

if (missing.length === 0) {
  console.log(`✅ All ${roundupEntries.length} roundup entries found in data/shows.json`);
  process.exit(0);
}

console.log(`⚠️  ${missing.length}/${roundupEntries.length} roundup entries missing from data/shows.json:`);
for (const entry of missing) {
  console.log(`  - "${entry.title}"${entry.venue ? ` (${entry.venue})` : ''}`);
}
process.exit(1);
