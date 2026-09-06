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
 * Exit 0 when nothing is flagged, 1 when something is, 2 when the sweep COULD
 * NOT RUN (no core data, wrong document shape, empty corpus) — a missing
 * shows.json must never look like a finding, or like a clean bill of health.
 *
 * Exit 0 when no unallowlisted id carries a market keyword at the seam between
 * its title slug and its market segment; exit 1 otherwise. The seam word need
 * not EQUAL the market segment ("...-tour-off-broadway-2026" counts) — the
 * signal is a market word at the join, whichever market it names.
 */

const fs = require('fs');
const path = require('path');
const { sweepShows, ALLOWLIST } = require('./lib/doubled-market-ids');

// EXIT 2 IS "COULD NOT RUN", AND IT HAS TO BE DISTINCT FROM EXIT 1.
// This reads data/shows.json, which a worktree does not have. Left to itself the
// missing file throws ENOENT and node exits 1 — the SAME code as "a bad id was
// found" — so a caller or a cron reads a checkout problem as a data defect, or
// worse, a data defect as noise it has learned to ignore. sweepShows() also
// tolerates a wrong-shaped document and hands back empty arrays, which then
// reports a clean corpus it never read.
// SHOWS_PATH exists so the exit contract below is TESTABLE. Everything about
// this script that a caller depends on is its exit code, and until the path was
// overridable the only way to exercise exit 2 was to move the real core data out
// from under a live checkout. A subprocess test now drives 0, 1 and 2 from
// fixtures (scripts/lib/doubled-market-ids.test.mjs). Production passes nothing
// and gets data/shows.json.
function loadShows() {
  const showsPath = process.env.SHOWS_PATH
    || path.join(__dirname, '..', 'data', 'shows.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  } catch (err) {
    console.error(`CANNOT RUN: could not read ${showsPath} — ${err.message}`);
    console.error('A worktree has no core data. Run ./scripts/setup-local-data.sh from the main checkout,');
    console.error('or symlink data/shows.json from ~/broadway-scorecard-data.');
    process.exit(2);
  }
  const shows = Array.isArray(raw) ? raw : raw && raw.shows;
  if (!Array.isArray(shows)) {
    console.error(`CANNOT RUN: ${showsPath} is neither an array nor an object with a "shows" array.`);
    process.exit(2);
  }
  if (!shows.length) {
    console.error(`CANNOT RUN: ${showsPath} holds zero shows — an empty corpus reports a clean sweep.`);
    process.exit(2);
  }
  return shows;
}

function main() {
  const shows = loadShows();
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
