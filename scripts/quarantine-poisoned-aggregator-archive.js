#!/usr/bin/env node
/**
 * quarantine-poisoned-aggregator-archive.js (BRO-6141)
 *
 * Deletes aggregator-archive pages that fail their own category check (a page
 * filed under one show's id that holds another show's, another production's or
 * another market's page), the pages scripts/audit-aggregator-archive-integrity.js
 * --strict reports. Same scan, same predicate (scripts/lib/aggregator-archive-scan.js).
 *
 * Delete only, no _not-found tombstone: unlike a sibling misfile (BRO-4779) the
 * show's own page may well exist, so the next scheduled scrape should be free to
 * fetch it. The writers refuse to re-archive a page that fails the check
 * (test-archive-writers-category-guard.js), so a refetch cannot restore a bad one.
 * Rollback is the private archive repo's git history (the workflow commits the deletions).
 *
 * Usage:
 *   node scripts/quarantine-poisoned-aggregator-archive.js [--archive=DIR]
 *   node scripts/quarantine-poisoned-aggregator-archive.js --delete --expect=N [--archive=DIR]
 *   node scripts/quarantine-poisoned-aggregator-archive.js --help, -h
 *
 * Exit: 0 clean / deleted, 1 poisoned pages found (report mode), 2 usage or count mismatch.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runQuarantine } = require('./lib/aggregator-archive-scan');

const ROOT = path.join(__dirname, '..');

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const showById = Object.fromEntries((raw.shows || raw).map(s => [s.id, s]));
  process.exitCode = runQuarantine(args, { defaultArchiveRoot: path.join(ROOT, 'data/aggregator-archive'), showById });
}

main();
