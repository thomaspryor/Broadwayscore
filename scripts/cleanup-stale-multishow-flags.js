#!/usr/bin/env node
/**
 * Cleanup stale isMultiShowReview flags.
 *
 * Re-runs the scorer's multi-show detector (scripts/llm-scoring/multi-show-detector.ts)
 * and clears flags that would no longer trigger.
 *
 * Usage: node scripts/cleanup-stale-multishow-flags.js [--dry-run] [--verbose]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// The scorer's own detector (BRO-5261): a second copy here drifted (it lacked
// the production-box signal and cleared every box-detected WSJ column).
require('module').createRequire(__filename)('tsx/cjs');
const { detectMultiShow } = require('./llm-scoring/multi-show-detector.ts');

// Walk review-texts directory
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
let total = 0;
let cleared = 0;
let stillFlagged = 0;
let errors = 0;

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (!data.isMultiShowReview) continue;
        total++;

        const text = data.fullText || '';
        const result = detectMultiShow(text, data.showId);

        if (!result.isMultiShowReview) {
          cleared++;
          if (verbose) {
            console.log(`CLEAR: ${fullPath.replace(reviewTextsDir + '/', '')} (was: ${data.multiShowReason || 'unknown'})`);
          }
          if (!dryRun) {
            delete data.isMultiShowReview;
            delete data.multiShowReason;
            fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
          }
        } else {
          stillFlagged++;
          // Update reason if it changed
          const newReason = result.reason || data.multiShowReason;
          if (!dryRun && newReason !== data.multiShowReason) {
            data.multiShowReason = newReason;
            fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
          }
        }
      } catch (e) {
        errors++;
        if (verbose) console.error(`Error processing ${fullPath}: ${e.message}`);
      }
    }
  }
}

console.log(`${dryRun ? '[DRY RUN] ' : ''}Cleaning up stale isMultiShowReview flags...`);
walkDir(reviewTextsDir);

console.log(`\nResults:`);
console.log(`  Total flagged: ${total}`);
console.log(`  Cleared (stale): ${cleared}`);
console.log(`  Still flagged: ${stillFlagged}`);
if (errors) console.log(`  Errors: ${errors}`);
if (dryRun) console.log(`\nRe-run without --dry-run to apply changes.`);
