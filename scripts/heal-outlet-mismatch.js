#!/usr/bin/env node
/**
 * heal-outlet-mismatch.js — run rebuild-all-reviews.js's stale outlet-mismatch
 * pass (scripts/lib/outlet-mismatch-heal.js runOutletMismatchCleanup) on its
 * own, without a full rebuild: URL-edition outletId rewrites (timeout.com
 * /london vs /newyork), misnamed-file rename/merge, and same-URL flagged
 * tombstone deletion.
 *
 * Dry-run by default; --apply writes.
 *
 *   node scripts/heal-outlet-mismatch.js                     # dry-run, whole corpus
 *   node scripts/heal-outlet-mismatch.js --show=ID[,ID2]     # limit to shows
 *   node scripts/heal-outlet-mismatch.js --dir=/path/to/review-texts --apply
 *
 * --dir defaults to REVIEW_TEXTS_DIR / resolveReviewTextsDir(). Only show
 * directories that exist in data/shows.json are processed (same filter as the
 * rebuild). Exit 1 if any file errored.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { runOutletMismatchCleanup } = require('./lib/outlet-mismatch-heal');

function parseArgs(argv) {
  const args = { apply: false, dir: null, shows: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--dir=')) args.dir = a.slice('--dir='.length);
    else if (a.startsWith('--show=')) args.shows = new Set(a.slice('--show='.length).split(',').filter(Boolean));
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/heal-outlet-mismatch.js [--dir=PATH] [--show=ID[,ID]] [--apply]');
    return 0;
  }
  const reviewTextsDir = args.dir || resolveReviewTextsDir();
  const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const showById = {};
  for (const s of showsData.shows) showById[s.id] = s;
  const showDirs = listShowDirs(reviewTextsDir, { silent: true })
    .filter(sid => showById[sid])
    .filter(sid => !args.shows || args.shows.has(sid))
    .filter(sid => !fs.lstatSync(path.join(reviewTextsDir, sid)).isSymbolicLink());

  console.log(`${args.apply ? 'APPLY' : 'DRY-RUN'}: ${showDirs.length} show dirs under ${reviewTextsDir}`);
  const r = runOutletMismatchCleanup({ reviewTextsDir, showDirs, showById, dryRun: !args.apply });
  console.log(`\n${r.editionFixedCount} URL-edition outletId fixes, ${r.renamedCount} renamed, ${r.mergedCount} merged+deleted, ${r.tombstoneDeletedCount} flagged tombstones deleted, ${r.skippedFlaggedCount} flagged tombstones left in place, ${r.errorCount} errors${r.skippedLockedCount ? `, ${r.skippedLockedCount} skipped (_locked)` : ''}`);
  for (const [reason, refs] of Object.entries(r.kept)) console.log(`  kept (${reason}): ${refs.length}`);
  if (!args.apply) console.log('(dry-run: nothing written; re-run with --apply)');
  return r.errorCount ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs };
