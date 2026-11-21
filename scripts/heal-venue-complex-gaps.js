#!/usr/bin/env node
/**
 * BRO-7403: link unlinked candidate sub-venue slugs.
 * Usage: node scripts/heal-venue-complex-gaps.js [--write]  (dry run without --write)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { VENUE_COMPLEX_MARKETS } = require('./lib/venue-complex-audit');
const { healCandidateGaps } = require('./lib/heal-venue-complex-gaps');

const write = process.argv.includes('--write');
const shows = require('../data/shows.json').shows;
let total = 0;
for (const market of VENUE_COMPLEX_MARKETS) {
  const file = path.join(__dirname, '..', market.defsFile);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { defs, added } = healCandidateGaps(shows, parsed.complexes, market.matches, market.key);
  const n = Object.values(added).reduce((a, l) => a + l.length, 0);
  total += n;
  for (const [c, l] of Object.entries(added)) console.log(`${market.key}: ${c} += ${l.join(', ')}`);
  if (write && n) {
    parsed.complexes = defs;
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
  }
}
console.log(`${total} slug(s) ${write ? 'linked' : 'would be linked'}`);
