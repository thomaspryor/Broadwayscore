#!/usr/bin/env node
/**
 * fix-excerpt-as-fulltext.js
 *
 * Cleans up review files where fullText is just a copy of an aggregator excerpt.
 * Sets fullText to null so collect-review-texts.js will attempt real scraping.
 *
 * Usage:
 *   node scripts/fix-excerpt-as-fulltext.js          # Dry run (default)
 *   node scripts/fix-excerpt-as-fulltext.js --apply   # Apply changes
 */
const fs = require('fs');
const path = require('path');

const dryRun = !process.argv.includes('--apply');
const base = path.join(__dirname, '..', 'data', 'review-texts');

let fixed = 0, skipped = 0, errors = 0;

const dirs = fs.readdirSync(base).filter(d => {
  try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
});

for (const d of dirs) {
  const files = fs.readdirSync(path.join(base, d)).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    const filePath = path.join(base, d, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (!data.fullText || data.fullText.length >= 300) {
        skipped++;
        continue;
      }

      const ft = data.fullText.trim();
      const excerpts = [data.dtliExcerpt, data.bwwExcerpt, data.showScoreExcerpt, data.nycTheatreExcerpt].filter(Boolean);
      const isExactCopy = excerpts.some(e => e.trim() === ft);

      if (!isExactCopy) {
        skipped++;
        continue;
      }

      // Clear the excerpt-as-fullText
      data.fullText = null;
      data.isFullReview = false;

      // If contentTier was based on the short fullText, reset it
      if (data.contentTier && data.contentTier !== 'excerpt') {
        data.contentTier = 'excerpt';
        data.contentTierReason = 'fullText was excerpt copy, cleared for re-scraping';
      }

      // Clear any LLM score that was based on the bad fullText
      // (scores on excerpts via rebuild-all-reviews.js will still work)
      if (data.llmScore && !data.humanReviewScore) {
        data.needsRescore = true;
      }

      if (!dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      fixed++;
    } catch (e) {
      errors++;
    }
  }
}

console.log(`${dryRun ? '[DRY RUN] ' : ''}Fix excerpt-as-fullText:`);
console.log(`  Fixed: ${fixed}`);
console.log(`  Skipped: ${skipped}`);
console.log(`  Errors: ${errors}`);

if (dryRun && fixed > 0) {
  console.log(`\nRun with --apply to make changes.`);
}
