#!/usr/bin/env node
/**
 * Sweep stale isRoundupArticle=true flags off review-text files that are
 * actually individual critic reviews (substantial fullText + isFullReview +
 * non-roundup URL). Identified by `isLikelyStaleRoundupFlag()` from
 * scripts/lib/review-guards.js.
 *
 * Background: Notion 34e637c5-416f-817b. The flag was set by older code paths
 * (URL-pattern matching in isRoundupUrl, blanket KNOWN_ROUNDUP_OUTLETS auto-tag
 * in gather-reviews) on legitimate individual reviews. The flag persisted on
 * disk after the producing code was tightened, silently dropping those reviews
 * from LLM scoring and from reviews.json.
 *
 * Usage:
 *   node scripts/clear-stale-roundup-flags.js [--apply] [--show=ID]
 *
 * Default mode is dry-run — prints the list and exits without writing.
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleRoundupFlag } = require('./lib/review-guards');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

let scanned = 0;
let flagged = 0;
let stale = 0;
const cleared = [];

for (const d of showDirs) {
  if (SHOW_FILTER && d.name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, d.name);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    scanned++;
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.isRoundupArticle !== true) continue;
    flagged++;
    if (!isLikelyStaleRoundupFlag(data)) continue;
    stale++;
    cleared.push(`${d.name}/${f}`);
    if (APPLY) {
      const hadTrailingNewline = fs.readFileSync(filePath, 'utf8').endsWith('\n');
      data.isRoundupArticle = false;
      data.roundupArticleClearedNote = '[2026-04-25 cleared stale isRoundupArticle — file has substantial fullText + isFullReview + non-roundup URL — Notion 34e637c5]';
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + (hadTrailingNewline ? '\n' : ''));
    }
  }
}

console.log(`Scanned: ${scanned} files`);
console.log(`isRoundupArticle=true: ${flagged}`);
console.log(`Stale (would clear): ${stale}`);
if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write changes.');
  console.log('\nFirst 20 affected files:');
  cleared.slice(0, 20).forEach(p => console.log('  ' + p));
} else {
  console.log(`\nAPPLIED — cleared ${stale} files.`);
}
