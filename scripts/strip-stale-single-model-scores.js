#!/usr/bin/env node
/**
 * Strip stale scores from review files.
 *
 * Two modes:
 *
 * Default mode: strip llmScore/llmMetadata from quality-flagged reviews.
 * These reviews have old single-model scores that are doubly dead:
 *   1. Quality flags (duplicateOf, wrongShow, etc.) cause rebuild to skip them
 *   2. Ensemble quality gate blocks single-model scores anyway
 * Never strips ensembleData (audit trail for ensemble-set rejections).
 *
 * --before-opening=YYYY-MM-DD mode: strip ALL scores (ensemble + llm) from reviews
 * where publishDate is 30+ days before the given date. Targets prior-production scores
 * that contaminate opening night scoring (e.g. OB scores on Broadway show's folder).
 * Only targets the specified --show=ID directory.
 *
 * Usage:
 *   node scripts/strip-stale-single-model-scores.js                     # dry-run (quality-flagged)
 *   node scripts/strip-stale-single-model-scores.js --apply             # write changes
 *   node scripts/strip-stale-single-model-scores.js --before-opening=2026-04-07 --show=cats-the-jellicle-ball-2026
 *   node scripts/strip-stale-single-model-scores.js --before-opening=2026-04-07 --show=cats-the-jellicle-ball-2026 --apply
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const showArg = process.argv.find(a => a.startsWith('--show='))?.replace('--show=', '');
const beforeOpeningArg = process.argv.find(a => a.startsWith('--before-opening='))?.replace('--before-opening=', '');

const QUALITY_FLAGS = [
  'duplicateOf',
  'wrongShow',
  'wrongProduction',
  'isRoundupArticle',
  'isMultiShowReview',
  'rejectionReason',
];

function hasQualityExclusion(data) {
  for (const flag of QUALITY_FLAGS) {
    if (data[flag]) return flag;
  }
  if (data.contentTier === 'invalid') return 'contentTier=invalid';
  return null;
}

function runQualityFlaggedMode() {
  const dirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
    catch { return false; }
  });

  let stripped = 0;
  let skipped = 0;
  const byFlag = {};

  for (const dir of dirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const fp = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch { continue; }

      // Only target reviews with llmScore but no ensembleData
      if (!data.llmScore || data.ensembleData) continue;

      const flag = hasQualityExclusion(data);
      if (!flag) { skipped++; continue; }

      byFlag[flag] = (byFlag[flag] || 0) + 1;
      stripped++;

      if (apply) {
        delete data.llmScore;
        delete data.llmMetadata;
        if (data.needsRescore) delete data.needsRescore;
        if (data.rescoreCompletedAt) delete data.rescoreCompletedAt;
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: Would strip llmScore/llmMetadata from ${stripped} flagged reviews`);
  console.log(`Skipped ${skipped} single-model reviews without quality flags (genuine upgrade candidates)`);
  console.log('\nBreakdown by flag:');
  for (const [flag, count] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flag}: ${count}`);
  }
  if (!apply) console.log('\nRun with --apply to write changes.');
}

function runBeforeOpeningMode(openingDateStr, showId) {
  if (!showId) { console.error('--before-opening requires --show=SHOW_ID'); process.exit(1); }
  const openingDate = new Date(openingDateStr);
  if (isNaN(openingDate.getTime())) { console.error(`Invalid date: ${openingDateStr}`); process.exit(1); }
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(openingDate.getTime() - THIRTY_DAYS_MS);

  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) { console.error(`Show directory not found: ${showDir}`); process.exit(1); }

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  let cleared = 0;
  let skipped = 0;

  for (const file of files) {
    const fp = path.join(showDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { continue; }

    // Must have a publishDate to compare
    if (!data.publishDate) { skipped++; continue; }
    const pubDate = new Date(data.publishDate);
    if (isNaN(pubDate.getTime())) { skipped++; continue; }

    // Only target reviews published 30+ days before opening (prior production contamination)
    if (pubDate >= cutoff) { skipped++; continue; }

    // Only act if there's a score to clear
    if (!data.ensembleData && !data.ensembleScore && !data.llmScore) { skipped++; continue; }

    const pubStr = pubDate.toISOString().split('T')[0];
    console.log(`  ${apply ? 'CLEAR' : 'WOULD CLEAR'}: ${file} (published ${pubStr}, ${Math.round((openingDate - pubDate) / 86400000)}d before opening)`);
    cleared++;

    if (apply) {
      delete data.ensembleData;
      delete data.ensembleScore;
      delete data.assignedScore;
      delete data.llmScore;
      delete data.llmMetadata;
      data.needsRescore = true;
      data.staleScoredBeforeOpening = true;
      fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
    }
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${cleared} reviews cleared, ${skipped} skipped`);
  console.log(`Show: ${showId} | Opening date: ${openingDateStr} | Cutoff: ${cutoff.toISOString().split('T')[0]}`);
  if (!apply) console.log('\nRun with --apply to write changes.');
}

if (beforeOpeningArg) {
  runBeforeOpeningMode(beforeOpeningArg, showArg);
} else {
  runQualityFlaggedMode();
}
