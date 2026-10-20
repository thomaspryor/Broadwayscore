#!/usr/bin/env node
'use strict';

/**
 * list-critic-spelling-duplicates.js (BRO-5740): list the same-show/same-outlet
 * critic-name near-duplicates in data/review-texts WITH the files behind each
 * spelling, so a fix plan (review-field-edit on criticName) can be written from
 * a cloud session that has no review-texts checkout. Prints names and file
 * names only, never review text. Run it with
 * `node scripts/cloud-run-script.js --review-texts scripts/list-critic-spelling-duplicates.js`.
 *
 * Output: one block per finding, ignoring none (no allow-list), so it shows
 * the known backlog too. `--json` prints the raw findings.
 */

const path = require('path');
const { scanReviewTextsForCriticDuplicates } = require('./lib/critic-spelling-duplicates');

const dir = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const { findings, scanned } = scanReviewTextsForCriticDuplicates(dir);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned, findings }, null, 1));
} else {
  console.log(`scanned ${scanned} review files, ${findings.length} near-duplicate pair(s)`);
  for (const f of findings) {
    console.log(`\n${f.showId} / ${f.outletId}`);
    console.log(`  "${f.nameA}" x${f.examplesA.length}: ${f.examplesA.join(', ')}`);
    console.log(`  "${f.nameB}" x${f.examplesB.length}: ${f.examplesB.join(', ')}`);
  }
}
