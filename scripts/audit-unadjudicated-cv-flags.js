#!/usr/bin/env node
'use strict';
/**
 * audit-unadjudicated-cv-flags.js (BRO-6237)
 *
 * Lists counted reviews (data/reviews.json) whose review-text file carries the
 * collector CV "not a review (preview|feature|news|interview)" verdict that no
 * human has adjudicated (no isNonReview, no nonReviewManualClear). Read-only.
 * Adjudicate each by reading the text: non-review -> pending-fix plan setting
 * isNonReviewReason "manual (not a review): ..." then isNonReview=true; real
 * review -> nonReviewManualClear=true (node scripts/new-fix-plan.js --review-edit).
 *
 * Usage: node scripts/audit-unadjudicated-cv-flags.js [--max=N] [--json=out.json]
 * Exit 0 at or under --max (default 0), 1 above it, 2 when data is missing.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { pickReviewTextsTree } = require('./lib/preflight-review-fix-plan');
const { findUnadjudicatedCounted } = require('./lib/unadjudicated-cv-flags');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/audit-unadjudicated-cv-flags.js [--max=N] [--json=out.json]  (read-only)');
    return 0;
  }
  const max = Number(argValue('max') || 0);
  const treeDir = pickReviewTextsTree();
  const reviewsPath = path.join(__dirname, '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath) || !fs.existsSync(treeDir)) {
    console.error(`missing data: ${reviewsPath} or ${treeDir}`);
    return 2;
  }
  const counted = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews || [];
  const files = [];
  for (const showId of listShowDirs(treeDir)) {
    for (const file of fs.readdirSync(path.join(treeDir, showId))) {
      if (!file.endsWith('.json')) continue;
      try {
        files.push({ showId, file, record: JSON.parse(fs.readFileSync(path.join(treeDir, showId, file), 'utf8')) });
      } catch { /* unreadable file is another audit's problem */ }
    }
  }
  const hits = findUnadjudicatedCounted(files, counted);
  for (const h of hits) console.log(`${h.showId}/${h.file}\t${h.record.url}`);
  console.log(`unadjudicated CV not-a-review flags on counted reviews: ${hits.length} (max ${max})`);
  const out = argValue('json');
  if (out) fs.writeFileSync(out, JSON.stringify(hits.map((h) => ({ showId: h.showId, file: h.file, url: h.record.url })), null, 2));
  return hits.length > max ? 1 : 0;
}

process.exit(main());
