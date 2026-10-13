#!/usr/bin/env node
'use strict';

/**
 * Drops the stale 'upcoming' tag from shows whose status moved past it
 * (open, previews or closed; BRO-3208). Runs daily in update-show-status.yml.
 * Companion remediation for the stale-upcoming-tag opening-night check.
 *
 * Usage:
 *   node scripts/fix-stale-upcoming-tags.js              # dry-run, reports all matches
 *   node scripts/fix-stale-upcoming-tags.js --apply       # writes the fix for all matches
 *   node scripts/fix-stale-upcoming-tags.js --show=ID --apply   # scope to one show
 *   node scripts/fix-stale-upcoming-tags.js --check       # exit 1 if any stale tag remains
 */

const fs = require('fs');
const path = require('path');
const { hasStoredStaleUpcomingTag } = require('./lib/opening-night-completeness.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-stale-upcoming-tags.js — Drops the stale 'upcoming' tag from open, previews and closed shows.

Usage:
  node scripts/fix-stale-upcoming-tags.js [--apply] [--show=ID] [--check]
  node scripts/fix-stale-upcoming-tags.js --help, -h    print this usage and exit
`;
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const check = args.includes('--check');
const showIdArg = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (check && apply) {
    console.error('--check is read-only; run --apply and --check as two separate commands.');
    process.exitCode = 2;
    return;
  }
  const data = loadShows();
  const shows = data.shows || [];

  const targets = shows.filter(s => (!showIdArg || s.id === showIdArg) && hasStoredStaleUpcomingTag(s));

  if (targets.length === 0) {
    console.log('No shows with a stale upcoming tag found.');
    return;
  }

  console.log(`${targets.length} show(s) with stale 'upcoming' tag:`);
  for (const s of targets) {
    console.log(`  - ${s.id} [${s.status}] (tags: ${JSON.stringify(s.tags)})`);
  }

  if (check) {
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to drop the tag.');
    return;
  }

  for (const s of targets) {
    s.tags = s.tags.filter(t => !(typeof t === 'string' && t.toLowerCase() === 'upcoming'));
  }

  const result = saveShows(data);
  console.log(`\nWrote shows.json (${result.lineCountBefore} -> ${result.lineCountAfter} lines). Fixed ${targets.length} show(s).`);
}

main();
