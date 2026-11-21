#!/usr/bin/env node
/**
 * Backfill isRoundupArticle for pull-quote-compilation pages already on disk
 * (BRO-2638). detectPullQuoteCompilation() (scripts/lib/roundup-digest.js) runs
 * only at write time, in review-file-writer Guard E4, so files written before
 * the guard, or by a path that skips it, were never checked. Same gap shape as
 * flag-bww-reviews-page-roundups.js.
 *
 * Usage:
 *   node scripts/backfill-roundup-pull-quote-compilation.js [--apply] [--show=ID] [--dir=PATH] [--force-bulk]
 *
 * Dry-run by default. --apply refuses more than SURGE_LIMIT flags without
 * --force-bulk, since this writes unattended to the private review-texts corpus.
 * Files with a manual isRoundupArticle=false clear are left alone.
 */
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { selectPullQuoteCompilation } = require('./lib/pull-quote-compilation-backfill');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { laneBypasses } = require('./lib/opening-night-lane/trust-model');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { listShowDirs } = require('./lib/list-show-dirs');

const SURGE_LIMIT = 50;

const USAGE = `backfill-roundup-pull-quote-compilation.js — flag pull-quote-compilation pages already on disk as isRoundupArticle.

Usage:
  node scripts/backfill-roundup-pull-quote-compilation.js [options]
  --apply         write the flags (default is a dry run)
  --show=ID       limit to one show directory
  --dir=PATH      review-texts root (default data/review-texts)
  --force-bulk    allow more than ${SURGE_LIMIT} flags in one run
  --help, -h      print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE_BULK = args.includes('--force-bulk');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';
const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');

// listShowDirs skips dangling symlinks instead of crashing the run (card #1610).
const showDirs = listShowDirs(REVIEW_TEXTS_DIR).filter(name => !name.startsWith('.') && !name.startsWith('_'));

let scanned = 0;
let unreadable = 0;
const toFlag = [];
for (const name of showDirs) {
  if (SHOW_FILTER && name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, name);
  let files;
  try { files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f)); } catch { continue; }
  for (const f of files) {
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { unreadable++; continue; }
    scanned++;
    if (laneBypasses(data, 'roundupUrlSwap')) continue; // BRO-4807: lane reviews are never flagged
    const hit = selectPullQuoteCompilation(data);
    if (hit) toFlag.push({ showId: name, file: f, filePath, reason: hit.reason });
  }
}

console.log(`Scanned ${scanned} review files across ${showDirs.length} show dirs (${unreadable} unreadable).`);
console.log(`Would flag: ${toFlag.length}\n`);
for (const item of toFlag) {
  console.log(`  ${item.showId}/${item.file}`);
  console.log(`    ${item.reason}`);
}

if (!APPLY) {
  console.log('\nDry run, no files written. Re-run with --apply to flag these files.');
  process.exit(0);
}
if (toFlag.length > SURGE_LIMIT && !FORCE_BULK) {
  console.error(`\nREFUSED: ${toFlag.length} flags exceeds the ${SURGE_LIMIT} surge guard. Review the list, then re-run with --force-bulk.`);
  process.exit(1);
}

let written = 0;
for (const item of toFlag) {
  // safeWriteReview re-reads the file at write time and merges, so a concurrent CI commit isn't clobbered.
  const res = safeWriteReview(item.filePath, {
    isRoundupArticle: true,
    roundupArticleReason: `auto: backfill (BRO-2638) — ${item.reason}`,
  });
  if (res && res.wrote === false) { console.error(`  NOT WRITTEN: ${item.showId}/${item.file}`); continue; }
  written++;
}
console.log(`\nAPPLIED — flagged ${written} file(s).`);
