#!/usr/bin/env node
'use strict';

/**
 * Drops the stale 'upcoming' tag from shows that are already status=open.
 * Companion remediation for the stale-upcoming-tag opening-night check.
 *
 * Usage:
 *   node scripts/fix-stale-upcoming-tags.js              # dry-run, reports all matches
 *   node scripts/fix-stale-upcoming-tags.js --apply       # writes the fix for all matches
 *   node scripts/fix-stale-upcoming-tags.js --show=ID --apply   # scope to one show
 */

const fs = require('fs');
const path = require('path');
const { hasStaleUpcomingTag } = require('./lib/opening-night-completeness.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-stale-upcoming-tags.js — Drops the stale 'upcoming' tag from shows that are already status=open.

Usage:
  node scripts/fix-stale-upcoming-tags.js [options]
  node scripts/fix-stale-upcoming-tags.js --help, -h    print this usage and exit
`;
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const showIdArg = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const data = loadShows();
  const shows = data.shows || [];

  const targets = shows.filter(s => (!showIdArg || s.id === showIdArg) && hasStaleUpcomingTag(s));

  if (targets.length === 0) {
    console.log('No shows with a stale upcoming tag found.');
    return;
  }

  console.log(`${targets.length} show(s) with stale 'upcoming' tag:`);
  for (const s of targets) {
    console.log(`  - ${s.id} (tags: ${JSON.stringify(s.tags)})`);
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to drop the tag.');
    return;
  }

  for (const s of targets) {
    s.tags = s.tags.filter(t => t !== 'upcoming');
  }

  const result = saveShows(data);
  console.log(`\nWrote shows.json (${result.lineCountBefore} -> ${result.lineCountAfter} lines). Fixed ${targets.length} show(s).`);
}

main();
