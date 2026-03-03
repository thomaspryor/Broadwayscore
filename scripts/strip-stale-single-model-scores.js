#!/usr/bin/env node
/**
 * One-time cleanup: Strip stale llmScore/llmMetadata from quality-flagged reviews.
 *
 * These reviews have old single-model scores that are doubly dead:
 * 1. Quality flags (duplicateOf, wrongShow, etc.) cause rebuild to skip them
 * 2. Ensemble quality gate blocks single-model scores anyway
 *
 * Never strips ensembleData (audit trail for ensemble-set rejections).
 *
 * Usage:
 *   node scripts/strip-stale-single-model-scores.js          # dry-run
 *   node scripts/strip-stale-single-model-scores.js --apply   # write changes
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');

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

function main() {
  const dirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
    catch { return false; }
  });

  let stripped = 0;
  let skipped = 0;
  let hasEnsemble = 0;
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
      if (!flag) {
        skipped++;
        continue;
      }

      byFlag[flag] = (byFlag[flag] || 0) + 1;
      stripped++;

      if (apply) {
        delete data.llmScore;
        delete data.llmMetadata;
        // Also clean up stale scoring artifacts
        if (data.needsRescore) delete data.needsRescore;
        if (data.rescoreCompletedAt) delete data.rescoreCompletedAt;
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: Would strip llmScore/llmMetadata from ${stripped} flagged reviews`);
  console.log(`Skipped ${skipped} single-model reviews without quality flags (these are genuine upgrade candidates)`);
  console.log('\nBreakdown by flag:');
  for (const [flag, count] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flag}: ${count}`);
  }
  if (!apply) console.log('\nRun with --apply to write changes.');
}

main();
