#!/usr/bin/env node
/**
 * enroll-announced-commercial-stubs.js (BRO-5776)
 *
 * Adds an empty TBD stub to commercial.json for every Broadway show that is
 * announced, upcoming, in previews or open and has no record. No LLM, no
 * network, no invented numbers (same stub as initialize-commercial-stub.js).
 * Shows at a nonprofit-owned house are listed so a human can set
 * designation Nonprofit + nonprofitOrg when that company produces them.
 *
 * Usage: node scripts/enroll-announced-commercial-stubs.js [--dry-run] [--json]
 */

require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const { createCommercialWriteGuard } = require('./lib/commercial-write-guard');
const { findUnenrolled, nonprofitHouseCandidate } = require('./lib/commercial-enrollment');
const { makeStub } = require('./initialize-commercial-stub');

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const dataDir = path.join(__dirname, '..', 'data');
  const shows = require(path.join(dataDir, 'shows.json')).shows || [];
  const { loadCommercial, saveCommercial } = createCommercialWriteGuard(path.join(dataDir, 'commercial.json'));
  const commercial = loadCommercial();
  const missing = findUnenrolled(shows, commercial.shows);
  const report = missing.map(s => ({ slug: s.slug, status: s.status, venue: s.venue || null, nonprofitHouse: nonprofitHouseCandidate(s) }));
  if (!dryRun) {
    for (const s of missing) commercial.shows[s.slug] = makeStub();
    if (missing.length) saveCommercial(commercial);
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ dryRun, enrolled: report }, null, 1));
  else {
    for (const r of report) console.log(`${dryRun ? 'would enroll' : 'enrolled'} ${r.slug} (${r.status}, ${r.venue || 'no venue'})${r.nonprofitHouse ? ` [${r.nonprofitHouse} house: confirm Nonprofit]` : ''}`);
    console.log(`[enroll-announced-commercial-stubs] ${report.length} stub(s) ${dryRun ? 'needed' : 'added'}`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
