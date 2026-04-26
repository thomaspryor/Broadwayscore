#!/usr/bin/env node
/**
 * Garbage-collect empty wrong-production stub files from review-texts.
 *
 * Background (Notion 34e637c5-416f-8167): opening-night automation creates
 * empty stub files when SERP/aggregator URL discovery returns wrong-year or
 * wrong-production URLs. These have:
 *   - wrongProduction: true
 *   - contentTier: 'invalid'
 *   - fullText: '' (no scraped content)
 *   - no excerpts, no score
 *
 * They pollute audit-critic-outlets.js skip counts, inflate stale-flag audit
 * results, and bloat critic-outlet affinity reports without contributing any
 * scoring signal.
 *
 * Re-pollution risk: review-file-writer.js merges into existing files
 * (line 300) but creates new files when the existing-file lookup fails. So
 * deleting a stub for an ACTIVELY-GATHERED show will trigger re-creation on
 * the next gather. To avoid the loop, the GC defaults to closed-show stubs
 * only (status='closed' in shows.json). Pass --include-open to also delete
 * open-show stubs (use with caution; they may regenerate).
 *
 * Safety guards (always preserved):
 *   - humanReviewedWrongProduction === false (manual override)
 *   - wrongProductionManualClear === true (manual override)
 *   - wrongProductionOverride === true (manual override)
 *   - assignedScore != null (file contributed a score somehow)
 *   - humanReviewScore != null (manual score)
 *   - hasExcerpt(data) (aggregator excerpt present — not an empty stub)
 *
 * Usage:
 *   node scripts/gc-wrong-production-stubs.js              # dry-run, closed shows only
 *   node scripts/gc-wrong-production-stubs.js --apply       # apply, closed shows only
 *   node scripts/gc-wrong-production-stubs.js --include-open --apply
 *   node scripts/gc-wrong-production-stubs.js --show=ID     # filter to one show
 *   node scripts/gc-wrong-production-stubs.js --dir=PATH    # override review-texts dir
 *
 * Default mode is dry-run. Pass --apply to delete files.
 */
const fs = require('fs');
const path = require('path');
const { hasExcerpt } = require('./lib/excerpt-fields');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_OPEN = args.includes('--include-open');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

// Build show-status map
let statusByShow;
try {
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const arr = shows.shows || shows;
  statusByShow = new Map(arr.map(s => [s.id, s.status]));
} catch (e) {
  console.error(`ERROR: cannot load shows.json — ${e.message}`);
  process.exit(1);
}

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

let scanned = 0;
let stubMatches = 0;
let preserved = { humanReviewed: 0, hasScore: 0, hasExcerpt: 0, openShow: 0, unknownShow: 0 };
let deletable = 0;
const deletables = [];

for (const d of showDirs) {
  if (SHOW_FILTER && d.name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, d.name);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    scanned++;
    const fp = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }

    // Cohort: empty wrong-production stub
    if (data.wrongProduction !== true) continue;
    if (data.contentTier !== 'invalid') continue;
    if ((data.fullText || '').length > 0) continue;
    stubMatches++;

    // Safety guards — never delete
    if (data.humanReviewedWrongProduction === false
        || data.wrongProductionManualClear === true
        || data.wrongProductionOverride === true) {
      preserved.humanReviewed++;
      continue;
    }
    if (data.assignedScore != null || data.humanReviewScore != null) {
      preserved.hasScore++;
      continue;
    }
    if (hasExcerpt(data)) {
      preserved.hasExcerpt++;
      continue;
    }

    // Show-status filter (re-pollution avoidance)
    const status = statusByShow.get(d.name);
    if (!status) {
      preserved.unknownShow++;
      continue;
    }
    if (status !== 'closed' && !INCLUDE_OPEN) {
      preserved.openShow++;
      continue;
    }

    deletable++;
    deletables.push(`${d.name}/${f}`);
    if (APPLY) {
      fs.unlinkSync(fp);
    }
  }
}

console.log(`Scanned: ${scanned} files`);
console.log(`Wrong-production empty stubs: ${stubMatches}`);
console.log('  Preserved:');
console.log(`    humanReviewed: ${preserved.humanReviewed}`);
console.log(`    hasScore: ${preserved.hasScore}`);
console.log(`    hasExcerpt: ${preserved.hasExcerpt}`);
console.log(`    openShow (--include-open to delete): ${preserved.openShow}`);
console.log(`    unknownShow (not in shows.json): ${preserved.unknownShow}`);
console.log(`  → DELETABLE: ${deletable}`);

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to delete files.');
  console.log('\nFirst 20 affected files:');
  deletables.slice(0, 20).forEach(p => console.log('  ' + p));
} else {
  console.log(`\nAPPLIED — deleted ${deletable} files.`);
}
