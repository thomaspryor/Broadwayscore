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
 *
 * Usage:
 *   node scripts/quarantine-poisoned-aggregator-archive.js [--archive=DIR] [--json]
 *   node scripts/quarantine-poisoned-aggregator-archive.js --delete --expect=N [--archive=DIR]
 *
 * Exit: 0 clean / deleted, 1 poisoned pages found (report mode), 2 usage or count mismatch.
 */
const fs = require('fs');
const path = require('path');
const { scanArchiveIntegrity } = require('./lib/aggregator-archive-scan');

const ROOT = path.join(__dirname, '..');

function loadShowMap() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const list = raw.shows || raw;
  return Object.fromEntries(list.map(s => [s.id, s]));
}

/** Unlink every scanned page; returns the count. */
function deletePages(hits) {
  for (const h of hits) fs.unlinkSync(h.file);
  return hits.length;
}

function main() {
  const args = process.argv.slice(2);
  const archiveArg = args.find(a => a.startsWith('--archive='));
  const archiveRoot = archiveArg ? path.resolve(archiveArg.slice(10)) : path.join(ROOT, 'data/aggregator-archive');
  const deleting = args.includes('--delete');
  if (!fs.existsSync(archiveRoot)) {
    if (deleting) { console.error(`archive not present at ${archiveRoot}: refusing a no-op --delete`); process.exitCode = 2; return; }
    console.log(`archive not present at ${archiveRoot}, nothing to audit`);
    return;
  }
  const { bad } = scanArchiveIntegrity(archiveRoot, loadShowMap());
  const json = args.includes('--json');
  const log = json ? console.error : console.log;
  if (json) console.log(JSON.stringify(bad.map(({ file, ...r }) => r)));
  else for (const b of bad) console.log(`${b.source}\t${b.showId}\t${b.reason}`);
  log(`\n${bad.length} poisoned archive page(s)`);
  if (deleting) {
    const expectArg = args.find(a => a.startsWith('--expect='));
    if (!expectArg || !/^\d+$/.test(expectArg.slice(9))) {
      console.error('--delete requires --expect=N (the number of poisoned pages the plan author saw)');
      process.exitCode = 2;
      return;
    }
    if (bad.length !== Number(expectArg.slice(9))) {
      console.error(`expected ${expectArg.slice(9)} poisoned page(s), found ${bad.length}: nothing deleted`);
      process.exitCode = 2;
      return;
    }
    log(`deleted ${deletePages(bad)} file(s)`);
    return;
  }
  if (bad.length) process.exitCode = 1;
}

module.exports = { deletePages };
if (require.main === module) main();
