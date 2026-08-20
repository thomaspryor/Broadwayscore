#!/usr/bin/env node
/**
 * One-off: Clear stale ensembleData from review-text files.
 *
 * When a single-model rescore overwrites llmScore/llmMetadata but leaves
 * old ensembleData intact, the file has misleading metadata. This script:
 *
 * 1. Clears ensembleData from files where llmMetadata.model is not an ensemble model
 * 2. Flags files with severe bucket divergence (2+ buckets between ensemble majority
 *    and current score) with needsRescore for re-ensemble scoring
 *
 * Run: node scripts/one-off/clear-stale-ensemble-data.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { markRescoreFlagged } = require('../lib/rescore-lifecycle');

// review-texts is gitignored; resolve from main repo root (handles worktrees)
const { execSync } = require('child_process');
const mainWorktree = execSync('git worktree list --porcelain', { encoding: 'utf8' })
  .split('\n').find(l => l.startsWith('worktree '))?.replace('worktree ', '') || __dirname.replace(/\/scripts\/.*/, '');
const REVIEW_TEXTS_DIR = path.join(mainWorktree, 'data/review-texts');
const DRY_RUN = process.argv.includes('--dry-run');

const BUCKET_ORDER = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
function bucketDistance(a, b) {
  return Math.abs(BUCKET_ORDER.indexOf(a) - BUCKET_ORDER.indexOf(b));
}

let cleared = 0;
let flagged = 0;
let total = 0;
const flaggedFiles = [];

function processDir(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      processDir(fp);
      continue;
    }
    if (!entry.endsWith('.json')) continue;

    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);

      if (!data.ensembleData) continue;
      total++;

      const isStale = data.llmMetadata?.model && !data.llmMetadata.model.startsWith('ensemble:');
      if (!isStale) continue;

      // Check for severe bucket divergence before clearing
      const ed = data.ensembleData;
      const buckets = [ed.claudeBucket, ed.openaiBucket, ed.geminiBucket, ed.kimiBucket].filter(Boolean);
      const counts = {};
      buckets.forEach(b => { counts[b] = (counts[b] || 0) + 1; });
      const majorityEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const majorityBucket = majorityEntry?.[0];
      const currentBucket = data.llmScore?.bucket;

      const isSevere = majorityBucket && currentBucket && bucketDistance(majorityBucket, currentBucket) >= 2;

      // Flag severe divergences for rescore (if not already flagged)
      if (isSevere && !data.needsRescore) {
        data.needsRescore = true;
        data.needsRescoreReason = 'stale-ensemble-severe-divergence';
        markRescoreFlagged(data);
        flagged++;
        const relPath = path.relative(REVIEW_TEXTS_DIR, fp);
        flaggedFiles.push(relPath);
        console.log(`  FLAG ${relPath}: majority=${majorityBucket} current=${currentBucket} (${bucketDistance(majorityBucket, currentBucket)} buckets apart)`);
      }

      // Clear stale ensembleData
      delete data.ensembleData;
      cleared++;

      if (!DRY_RUN) {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    } catch (e) {
      // Skip unparseable files
    }
  }
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning review-text files for stale ensembleData...\n`);
processDir(REVIEW_TEXTS_DIR);

console.log(`\nResults:`);
console.log(`  Total files with ensembleData: ${total}`);
console.log(`  Stale ensembleData cleared: ${cleared}`);
console.log(`  Flagged for rescore (severe divergence): ${flagged}`);
if (flaggedFiles.length > 0) {
  console.log(`\nFlagged files:`);
  flaggedFiles.forEach(f => console.log(`  - ${f}`));
}
if (DRY_RUN) {
  console.log(`\nThis was a dry run. Re-run without --dry-run to apply changes.`);
}
