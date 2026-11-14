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
const fs = require('fs');
if (!fs.existsSync(dir)) {
  console.error(`no review-texts corpus at ${dir} (set REVIEW_TEXTS_DIR or run with --review-texts)`);
  process.exit(2);
}
// --detail=<showId>/<file>,... : metadata only (url, dates, text length, flags) so a
// keep/delete choice between two files for one critic can be made without review text.
const detailArg = process.argv.find((a) => a.startsWith('--detail='));
const { findings, scanned } = detailArg ? { findings: [], scanned: 0 } : scanReviewTextsForCriticDuplicates(dir);

if (detailArg) {
  const fs = require('fs');
  for (const rel of detailArg.slice('--detail='.length).split(',')) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
      const len = (k) => (typeof r[k] === 'string' ? r[k].length : 0);
      console.log(`${rel}: url=${r.url || ''} publishDate=${r.publishDate || ''} source=${r.source || ''} textLen=${Math.max(len('fullText'), len('text'))} excerptLen=${len('excerpt')} isFullReview=${r.isFullReview} score=${r.assignedScore ?? r.originalScore ?? ''} flags=${['wrongShow', 'wrongProduction', 'isNonReview', 'duplicateOf'].filter((k) => r[k]).join('|')}`);
    } catch (e) {
      console.log(`${rel}: unreadable (${e.code || e.message})`);
    }
  }
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned, findings }, null, 1));
} else {
  console.log(`scanned ${scanned} review files, ${findings.length} near-duplicate pair(s)`);
  for (const f of findings) {
    console.log(`\n${f.showId} / ${f.outletId}`);
    console.log(`  "${f.nameA}" x${f.examplesA.length}: ${f.examplesA.join(', ')}`);
    console.log(`  "${f.nameB}" x${f.examplesB.length}: ${f.examplesB.join(', ')}`);
  }
}
