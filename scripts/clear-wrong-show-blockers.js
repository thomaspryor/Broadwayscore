#!/usr/bin/env node
/**
 * Clear wrongShow slot-blockers: delete files that have wrongShow=true and contain
 * no useful data (no score, no LLM score, no aggregator data, no meaningful text).
 * These files block gather-reviews from re-discovering correct URLs.
 *
 * Usage: node scripts/clear-wrong-show-blockers.js [--dry-run] [--include-scored]
 *
 * --dry-run: Print what would be deleted without actually deleting
 * --include-scored: Also delete wrongShow files that have scores (more aggressive)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeScored = args.includes('--include-scored');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

let deleted = 0;
let kept = 0;
let total = 0;
const deletedByShow = {};

for (const showDir of fs.readdirSync(REVIEW_TEXTS_DIR)) {
  const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
  if (!fs.statSync(showPath).isDirectory()) continue;

  for (const file of fs.readdirSync(showPath)) {
    if (!file.endsWith('.json')) continue;
    const filepath = path.join(showPath, file);

    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if (!data.wrongShow) continue;
      total++;

      // Check for useful data worth preserving
      const hasScore = !!(data.assignedScore || data.originalScore);
      const hasLlmScore = !!data.llmScore;
      const hasAggData = !!(data.bwwScore || data.bwwExcerpt || data.showScoreRating || data.showScoreExcerpt);
      const hasText = (data.fullText || data.text || '').length > 100;

      const hasUsefulData = hasScore || hasLlmScore || hasAggData;

      // In default mode: only delete pure junk (no scores, no text)
      // In --include-scored mode: delete even files with scores (they're for the wrong show anyway)
      const shouldDelete = includeScored ? true : (!hasUsefulData && !hasText);

      if (shouldDelete) {
        if (!dryRun) {
          fs.unlinkSync(filepath);
        }
        deleted++;
        deletedByShow[showDir] = (deletedByShow[showDir] || 0) + 1;
      } else {
        kept++;
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
}

console.log(`\n${dryRun ? '[DRY RUN] ' : ''}wrongShow cleanup results:`);
console.log(`  Total wrongShow files: ${total}`);
console.log(`  Deleted: ${deleted}`);
console.log(`  Kept (has useful data): ${kept}`);
console.log(`  Mode: ${includeScored ? 'aggressive (include scored)' : 'conservative (pure junk only)'}`);

if (deleted > 0) {
  const showCount = Object.keys(deletedByShow).length;
  console.log(`\n  Affected ${showCount} shows. Top 10:`);
  const sorted = Object.entries(deletedByShow).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 10).forEach(([show, count]) => {
    console.log(`    ${show}: ${count} deleted`);
  });
}
