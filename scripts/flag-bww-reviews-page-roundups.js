#!/usr/bin/env node
/**
 * Sweep review-texts for BroadwayWorld /reviews/{slug} critics-aggregation
 * pages ingested as individual reviews and flag them isRoundupArticle.
 *
 * Background: Notion 39d637c5-416f-81eb. BWW's /reviews/{slug} page is a
 * quote mosaic of OTHER outlets' reviews plus a critics-average score widget
 * — not an individual BWW review (distinct from /article/BWW-Review-... which
 * is BWW's own writing). the-whoopi-monologues-off-broadway-2026 shipped one
 * of these live as a 13th T1 review (2026-07-14): score came from the average
 * widget, criticName from a quoted outlet's JSON-LD Person markup.
 *
 * isRoundupUrl() / isRoundupPageAsReview() now reject these going forward
 * (review-guards.js). This sweeps files written before that fix landed.
 *
 * Usage:
 *   node scripts/flag-bww-reviews-page-roundups.js [--apply] [--show=ID]
 *
 * Default mode is dry-run — prints the list and exits without writing.
 */
const fs = require('fs');
const path = require('path');
const { isRoundupUrl, shouldSkipRoundupAudit } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

let scanned = 0;
const toFlag = [];

for (const d of showDirs) {
  if (SHOW_FILTER && d.name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, d.name);
  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch {
    continue;
  }
  for (const f of files) {
    const filePath = path.join(showDir, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    scanned++;
    if (!data.url) continue;
    const roundup = isRoundupUrl(data.url);
    if (!roundup.isRoundup) continue;
    // Scope to BWW aggregation pages: /reviews/{slug} quote-mosaic pages plus
    // /article/Review-Roundup- staff compilations (2026-07-19 Oresteia leak).
    if (!/broadwayworld\.com\/(reviews\/|(?:[a-z0-9-]+\/)?article\/review-roundup-)/i.test(data.url)) continue;
    if (data.isRoundupArticle === true) continue; // already flagged
    if (shouldSkipRoundupAudit(data)) continue; // manually cleared — respect it
    toFlag.push({ showId: d.name, file: f, filePath, url: data.url, criticName: data.criticName, data });
  }
}

console.log(`Scanned ${scanned} review files across ${showDirs.length} show dirs.`);
console.log(`Found ${toFlag.length} unflagged BWW aggregation page(s) (/reviews/ or /article/Review-Roundup-):\n`);

for (const item of toFlag) {
  console.log(`  ${item.showId}/${item.file}`);
  console.log(`    url: ${item.url}`);
  console.log(`    criticName: ${item.criticName}`);
}

if (!APPLY) {
  console.log('\nDry run — no files written. Re-run with --apply to flag these files.');
  process.exit(0);
}

let written = 0;
for (const item of toFlag) {
  // safeWriteReview re-reads the file fresh at write time and merges — protects
  // against a concurrent CI commit touching this file between scan and apply.
  const isRoundupArticleUrl = /article\/review-roundup-/i.test(item.url);
  safeWriteReview(item.filePath, {
    isRoundupArticle: true,
    roundupArticleReason: isRoundupArticleUrl
      ? 'auto: sweep — URL is a BWW /article/Review-Roundup- staff compilation of other outlets’ reviews (2026-07-19 Oresteia leak)'
      : 'auto: sweep — URL matches BWW /reviews/ critics-aggregation page pattern (Notion 39d637c5-416f-81eb)',
  });
  written++;
}
console.log(`\nFlagged ${written} file(s).`);
