#!/usr/bin/env node

/**
 * Backfill incompleteReason on all non-complete review files.
 *
 * Usage:
 *   node scripts/backfill-incomplete-reasons.js [--dry-run] [--show=SHOW_ID]
 */

const fs = require('fs');
const path = require('path');
const { classifyContentTier } = require('./lib/content-quality');
const { safeWriteReview } = require('./lib/review-write-guard');
const { classifyIncompleteReason } = require('./lib/incomplete-reason');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const FAILED_FETCHES_PATH = path.join(REVIEW_TEXTS_DIR, 'failed-fetches.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '');

// Load failed-fetches into a Map
function loadFailedFetchMap() {
  const map = new Map();
  try {
    const entries = JSON.parse(fs.readFileSync(FAILED_FETCHES_PATH, 'utf8'));
    for (const entry of entries) {
      if (entry.reviewId) map.set(entry.reviewId, entry);
    }
  } catch (e) {
    console.log('Warning: Could not load failed-fetches.json:', e.message);
  }
  return map;
}

function main() {
  console.log('='.repeat(60));
  console.log('  Backfill incompleteReason');
  if (DRY_RUN) console.log('  *** DRY RUN — no files will be modified ***');
  if (SHOW_FILTER) console.log('  Show filter:', SHOW_FILTER);
  console.log('='.repeat(60));
  console.log();

  const failedFetchMap = loadFailedFetchMap();
  console.log('Loaded', failedFetchMap.size, 'failed-fetch entries');

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR);
  const stats = {
    total: 0,
    complete: 0,
    classified: 0,
    changed: 0,
    tierFixed: 0,
    completeWithWrongFlags: 0,
    reasons: {},
  };

  for (const showDir of showDirs) {
    if (SHOW_FILTER && showDir !== SHOW_FILTER) continue;
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    let stat;
    try { stat = fs.statSync(showPath); } catch { continue; }
    if (stat.isDirectory() === false) continue;

    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(showPath, file);
      const reviewId = showDir + '/' + file;
      stats.total++;

      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { continue; }

      // Fix missing contentTier
      if (data.contentTier === undefined || data.contentTier === null) {
        const tierResult = classifyContentTier(data);
        data.contentTier = tierResult.contentTier;
        data.contentTierReason = tierResult.tierReason;
        stats.tierFixed++;
      }

      // Log complete + wrong flags contradictions
      if (data.contentTier === 'complete' && (data.wrongShow || data.wrongProduction)) {
        stats.completeWithWrongFlags++;
        if (SHOW_FILTER) {
          console.log('  WARNING: complete + wrong flags:', reviewId);
        }
      }

      // Classify
      const ffEntry = failedFetchMap.get(reviewId);
      const result = classifyIncompleteReason(data, ffEntry);

      if (result === null) {
        // Complete review — clear any stale reason
        stats.complete++;
        if (data.incompleteReason) {
          if (DRY_RUN === false) {
            delete data.incompleteReason;
            delete data.incompleteDetail;
            safeWriteReview(filePath, data, { force: true });
          }
          stats.changed++;
        }
        continue;
      }

      stats.classified++;
      stats.reasons[result.incompleteReason] = (stats.reasons[result.incompleteReason] || 0) + 1;

      // Check if anything changed
      if (data.incompleteReason === result.incompleteReason) continue;

      stats.changed++;
      if (SHOW_FILTER) {
        console.log('  ', reviewId, ':', data.contentTier, '→', result.incompleteReason, '—', result.incompleteDetail);
      }

      if (DRY_RUN === false) {
        data.incompleteReason = result.incompleteReason;
        data.incompleteDetail = result.incompleteDetail;
        safeWriteReview(filePath, data);
      }
    }
  }

  // Summary
  console.log();
  console.log('='.repeat(60));
  console.log('  Summary');
  console.log('='.repeat(60));
  console.log('  Total files:', stats.total);
  console.log('  Complete:', stats.complete);
  console.log('  Classified:', stats.classified);
  console.log('  Changed:', stats.changed, DRY_RUN ? '(would change)' : '');
  console.log('  ContentTier fixed (was missing):', stats.tierFixed);
  console.log('  Complete + wrong flags (WARNING):', stats.completeWithWrongFlags);
  console.log();
  console.log('  Reason distribution:');
  const sorted = Object.entries(stats.reasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log('    ' + reason.padEnd(20) + count);
  }
  console.log('='.repeat(60));
}

main();
