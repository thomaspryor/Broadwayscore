#!/usr/bin/env node

/**
 * build-recovery-list.js — Generate the S3 Phase A recovery target list
 *
 * Reads `data/audit/wp-classifier-disagreements.json` (the cross-classifier
 * cohort partition produced by `audit-wrong-production.js`) and writes a
 * frozen snapshot of the `outlier_safe` partition, filtered down to entries
 * that are actually recoverable end-to-end.
 *
 * Cohort:
 *   `outlier_safe` = P3 review files (empty fullText, valid llmScore) that
 *   `audit-wrong-production.js` classified as legitimate reviews (NOT
 *   wrong-production). Their fullText was stripped during a prior
 *   content-quality migration; their llmScores are stale (based on the
 *   now-stripped text). Recovering text + re-scoring restores catalog
 *   quality without changing what reviews are actually included.
 *
 * Filter rules (drop if):
 *   1. `url` is empty/null  — can't recover without a source URL
 *   2. Review file is missing on disk
 *   3. Review file already has any of these gating flags:
 *        wrongProduction, wrongShow, isNonReview, duplicateOf,
 *        rejectedAt, isRoundupArticle
 *      (the rebuild gate excludes these anyway — no value in recovering)
 *   4. `fabricatedEntry === true` (collect-review-texts skips these
 *      unless `--reason-filter` is set; not recoverable in normal flow)
 *   5. `incompleteReason === 'permanently_unavailable'` (broken redirects)
 *   6. Domain is in DEAD_DOMAINS (currently just `jasonraize.net` per
 *      `scripts/cleanup-failed-fetches.js`)
 *
 * Output: `data/audit/recovery-targets-2026-04-26.json`
 *   {
 *     _meta: { generatedAt, cohortSize, source, filterApplied },
 *     targets: [{ showId, file, url, outletId, publishDate }]
 *   }
 *
 * Re-runnable as the cohort drifts: re-run `audit-wrong-production.js` to
 * refresh the input partitions, then `node scripts/build-recovery-list.js`.
 *
 * Usage:
 *   node scripts/build-recovery-list.js
 *   node scripts/build-recovery-list.js --output=path/to/file.json
 *
 * Exit codes:
 *   0 — wrote target list
 *   1 — input missing or unreadable
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'data', 'audit', 'wp-classifier-disagreements.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'audit', 'recovery-targets-2026-04-26.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

// Mirrors DEAD_DOMAINS in scripts/cleanup-failed-fetches.js
const DEAD_DOMAINS = new Set([
  'jasonraize.net',
  'www.jasonraize.net',
]);

const GATING_FLAGS = [
  'wrongProduction',
  'wrongShow',
  'isNonReview',
  'duplicateOf',
  'rejectedAt',
  'isRoundupArticle',
];

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function getDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return null; }
}

function isDeadDomain(url) {
  const d = getDomain(url);
  if (!d) return false;
  for (const dd of DEAD_DOMAINS) {
    if (d === dd || d.endsWith('.' + dd)) return true;
  }
  return false;
}

function deriveOutletId(file) {
  // Filename pattern: <outletId>--<critic-slug>.json (or rarely <outletId>.json)
  // outletId is the part before the first `--`.
  const base = file.replace(/\.json$/, '');
  const idx = base.indexOf('--');
  return idx > 0 ? base.slice(0, idx) : base;
}

function readReviewFile(showId, file) {
  const fp = path.join(REVIEW_TEXTS_DIR, showId, file);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

function main() {
  const args = parseArgs(process.argv);
  const outputPath = args.output ? path.resolve(args.output) : DEFAULT_OUTPUT;

  if (!fs.existsSync(INPUT)) {
    console.error(`ERROR: input not found: ${INPUT}`);
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const safe = (audit.partitions && audit.partitions.outlier_safe) || [];

  const stats = {
    cohort: safe.length,
    droppedNoUrl: 0,
    droppedFileMissing: 0,
    droppedDeadDomain: 0,
    droppedFabricated: 0,
    droppedPermanentlyUnavailable: 0,
    droppedGated: 0,
    droppedGatingByFlag: Object.fromEntries(GATING_FLAGS.map(f => [f, 0])),
    kept: 0,
  };

  const targets = [];
  for (const e of safe) {
    if (!e.url || typeof e.url !== 'string' || !e.url.trim()) {
      stats.droppedNoUrl++;
      continue;
    }
    if (isDeadDomain(e.url)) {
      stats.droppedDeadDomain++;
      continue;
    }
    const review = readReviewFile(e.showId, e.file);
    if (!review) {
      stats.droppedFileMissing++;
      continue;
    }
    if (review.fabricatedEntry === true) {
      stats.droppedFabricated++;
      continue;
    }
    if (review.incompleteReason === 'permanently_unavailable') {
      stats.droppedPermanentlyUnavailable++;
      continue;
    }
    let gated = false;
    for (const flag of GATING_FLAGS) {
      if (review[flag]) {
        stats.droppedGatingByFlag[flag]++;
        gated = true;
      }
    }
    if (gated) {
      stats.droppedGated++;
      continue;
    }

    targets.push({
      showId: e.showId,
      file: e.file,
      url: e.url,
      outletId: review.outletId || deriveOutletId(e.file),
      publishDate: e.publishDate || review.publishDate || null,
      llmScore: typeof e.llmScore === 'number' ? e.llmScore : null,
    });
    stats.kept++;
  }

  const out = {
    _meta: {
      generatedAt: new Date().toISOString(),
      cohortSize: stats.kept,
      cohortSizeBeforeFilter: stats.cohort,
      source: 'outlier_safe partition from data/audit/wp-classifier-disagreements.json',
      filterApplied: 'drop empty url; drop missing review file; drop wrongProduction/wrongShow/isNonReview/duplicateOf/rejectedAt/isRoundupArticle; drop fabricatedEntry; drop incompleteReason=permanently_unavailable; drop DEAD_DOMAINS (jasonraize.net)',
      stats,
    },
    targets,
  };

  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));

  console.log(`Wrote ${targets.length} targets → ${path.relative(ROOT, outputPath)}`);
  console.log(`  Cohort: ${stats.cohort}`);
  console.log(`  Dropped no-url:        ${stats.droppedNoUrl}`);
  console.log(`  Dropped file-missing:  ${stats.droppedFileMissing}`);
  console.log(`  Dropped dead-domain:   ${stats.droppedDeadDomain}`);
  console.log(`  Dropped fabricated:    ${stats.droppedFabricated}`);
  console.log(`  Dropped perm-unavail:  ${stats.droppedPermanentlyUnavailable}`);
  console.log(`  Dropped gated total:   ${stats.droppedGated}`);
  for (const f of GATING_FLAGS) {
    if (stats.droppedGatingByFlag[f] > 0) {
      console.log(`    ${f}: ${stats.droppedGatingByFlag[f]}`);
    }
  }
  console.log(`  Kept:                  ${stats.kept}`);
}

if (require.main === module) main();
