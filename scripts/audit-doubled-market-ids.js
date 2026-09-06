#!/usr/bin/env node

/**
 * audit-doubled-market-ids.js — standing detector for BRO-2886's shape: a
 * shows.json id carrying its market segment twice, which happens when a show's
 * TITLE has absorbed its market and the id is built from that title's slug.
 *
 * The one live instance (the Almeida production of "1536", recorded as
 * "1536 West End" under id 1536-west-end-off-west-end-2026) was corrected in
 * broadway-scorecard-data 0506baa51. This script exists so a second one is
 * caught by a command instead of by a corpus sweep somebody happens to run.
 *
 * Decision logic is in scripts/lib/doubled-market-ids.js so the test asserts the
 * real function rather than a copy (CLAUDE.md rule 15).
 *
 * Exit 0 when no unallowlisted id doubles its market; exit 1 otherwise.
 */

const fs = require('fs');
const path = require('path');
const { sweepShows, ALLOWLIST } = require('./lib/doubled-market-ids');

function main() {
  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const { flagged, allowlisted } = sweepShows(shows);

  console.log(`Doubled-market id sweep: ${shows.length} shows scanned.`);
  console.log(`  allowlisted (checked: the market word belongs to the title or the run descriptor): ${allowlisted.length}`);
  for (const row of allowlisted) {
    console.log(`    ${row.id} — ${JSON.stringify(row.title)}`);
    console.log(`      ${row.reason}`);
  }
  console.log(`  flagged: ${flagged.length}`);
  for (const row of flagged) {
    console.log(`    ${row.id} — title ${JSON.stringify(row.title)}`);
    console.log(`      title slug ends in "${row.doubledWord}" and the id's market segment is "${row.market}"`);
  }

  if (flagged.length) {
    console.error('');
    console.error('A flagged id means one of two things, and they need different fixes:');
    console.error('  1. the TITLE is wrong (a market word was pulled in from somewhere it did');
    console.error('     not belong) — fix the title, then rebuild the id and slug from it, and');
    console.error('     move the per-show artifacts with git mv;');
    console.error('  2. the title is RIGHT and the show is genuinely named after a market —');
    console.error(`     add the id to ALLOWLIST in scripts/lib/doubled-market-ids.js with the`);
    console.error('     source you checked it against.');
    console.error('Do NOT edit shows.json from memory (CLAUDE.md rule 3): look the title up first.');
    process.exit(1);
  }
  console.log(`\nOK — 0 unallowlisted doubled-market ids (${ALLOWLIST.size} allowlisted).`);
  process.exit(0);
}

main();
