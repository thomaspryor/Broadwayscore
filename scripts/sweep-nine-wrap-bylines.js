#!/usr/bin/env node
'use strict';
/**
 * BRO-8457: audit stored Nine live-reviews wrap rows (theage/smh/brisbanetimes/watoday
 * /culture/live-reviews/) for a non-first item credited to the page byline (the first
 * item's critic). --apply renames the row to the item's own critic (new filename), cuts
 * the text to the item (planIsolation) and flags a rescore. Manual/_locked rows are only
 * reported. Items with no byline are reported, not renamed (nothing to rename to).
 * Usage: node scripts/sweep-nine-wrap-bylines.js [--apply] [--dir=PATH]
 */
const fs = require('fs');
const path = require('path');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { listShowDirs } = require('./lib/list-show-dirs');
const { planSectionBylineFix, planIsolation } = require('./lib/multi-show-isolation-plan');

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.slice(6) : (process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts'));
  const at = new Date().toISOString();
  let seen = 0; let bad = 0; let fixed = 0; let skipped = 0; let unverified = 0;
  for (const showId of listShowDirs(dir)) {
    if (showId[0] === '_' || showId[0] === '.') continue;
    for (const file of fs.readdirSync(path.join(dir, showId))) {
      if (!isReviewTextFile(file)) continue;
      const fp = path.join(dir, showId, file);
      let data; try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!/^https?:\/\/(?:www\.)?(?:theage|smh|brisbanetimes|watoday)\.com\.au\/culture\/live-reviews\//.test(data.url || '')) continue;
      seen++;
      const r = planSectionBylineFix(data, showId);
      if (r.ok || !r.mismatch) {
        if (!r.ok && /^cannot-verify/.test(r.skip || '')) unverified++; console.log(`  ok      ${showId}/${file}${r.skip ? ` (${r.skip})` : ''}`); continue; }
      bad++;
      console.log(`  MISMATCH ${showId}/${file}: ${r.from} -> ${r.to || '(no byline)'}${r.manual ? ' [manual/locked: left]' : ''}`);
      if (!apply || r.manual || !r.to) { if (apply) skipped++; continue; }
      const { generateReviewFilename } = require('./lib/review-normalization');
      const { safeRenameReview } = require('./lib/review-write-guard');
      const plan = planIsolation(data, showId, at);
      const out = { ...(plan && plan.data ? plan.data : data), criticName: r.to };
      const dest = path.join(dir, showId, generateReviewFilename(file.split('--')[0], r.to));
      const res = safeRenameReview(fp, dest, { newData: out });
      if (!res || res.wrote === false) { skipped++; console.log(`  skip    ${file}: ${res && res.skipped}`); continue; }
      fixed++;
      console.log(`  renamed ${file} -> ${path.basename(dest)}`);
    }
  }
  console.log(`[sweep-nine-wrap-bylines] ${seen} Nine live-reviews row(s), ${bad} mismatched, ${fixed} fixed, ${skipped} skipped, ${unverified} unverifiable${apply ? '' : ' (dry run)'}`);
}
if (require.main === module) main();
