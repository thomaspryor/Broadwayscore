#!/usr/bin/env node
'use strict';
/**
 * One-time cleanup: flag review-roundup DIGESTS that were mis-stored as individual
 * outlet reviews (chiefly WestEndTheatre.com roundup pages under telegraph/timeout/
 * standard ids). Uses the shared scripts/lib/roundup-digest.js detector — content/
 * byline based, so it does NOT touch a real critic's relayed excerpt.
 *
 * SAFETY: refuses to flag a review that is currently INCLUDED in reviews.json
 * unless --allow-included is passed (none should be — verified 2026-06-30 that the
 * only counted WET-url review is a legit Tim Bano excerpt the detector skips).
 *
 * Usage: node scripts/flag-wet-roundup-misattributions.js [--apply] [--allow-included]
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { detectRoundupDigest } = require('./lib/roundup-digest');
const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const ALLOW_INCLUDED = process.argv.includes('--allow-included');
const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Build the set of currently-included (show,outlet,critic) so we never silently
// drop a counted review.
const rj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reviews.json'), 'utf8'));
const revs = Array.isArray(rj) ? rj : (rj.reviews || []);
const included = new Set(revs.map(r => `${r.showId}|${r.outletId}|${r.criticName}`));

let flagged = 0, skippedAlready = 0, skippedIncluded = 0;
for (const f of glob.sync(path.join(REVIEW_DIR, '*', '*.json'))) {
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (d.isRoundupArticle === true) { continue; }
  const verdict = detectRoundupDigest({ fullText: d.fullText, criticName: d.criticName, url: d.url, outletId: d.outletId });
  if (!verdict) continue;
  const showId = path.basename(path.dirname(f));
  const key = `${showId}|${d.outletId}|${d.criticName}`;
  if (included.has(key) && !ALLOW_INCLUDED) {
    console.warn(`  ⚠️  SKIP (currently included in reviews.json): ${showId}/${path.basename(f)} — ${verdict.reason}`);
    skippedIncluded++;
    continue;
  }
  console.log(`  ${APPLY ? 'FLAG' : 'would-flag'}: ${showId}/${path.basename(f)} — ${verdict.reason}`);
  if (APPLY) {
    d.isRoundupArticle = true;
    d.roundupArticleReason = `cleanup 2026-06-30: ${verdict.reason}`;
    safeWriteReview(f, d, { force: true });
  }
  flagged++;
}
console.log(`\n${APPLY ? 'Flagged' : 'Would flag'}: ${flagged} | already-flagged-skipped: ${skippedAlready} | included-skipped: ${skippedIncluded}`);
if (!APPLY) console.log('(dry run — pass --apply to write)');
