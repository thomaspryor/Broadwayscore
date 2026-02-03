#!/usr/bin/env node
/**
 * fix-nav-contaminated.js
 *
 * Cleans up review files where fullText starts with "Skip to content" followed
 * by site navigation junk (TheWrap, BroadwayNews, NY Daily News, etc.).
 * Re-runs cleanText() which now includes stripLeadingNavigation().
 *
 * Usage:
 *   node scripts/fix-nav-contaminated.js          # Dry run (default)
 *   node scripts/fix-nav-contaminated.js --apply   # Apply changes
 */
const fs = require('fs');
const path = require('path');
const { cleanText } = require('./lib/text-cleaning');
const { classifyContentTier } = require('./lib/content-quality');

const dryRun = !process.argv.includes('--apply');
const base = path.join(__dirname, '..', 'data', 'review-texts');

let fixed = 0, skipped = 0, errors = 0;
const results = [];

const dirs = fs.readdirSync(base).filter(d => {
  try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
});

for (const d of dirs) {
  const files = fs.readdirSync(path.join(base, d)).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    const filePath = path.join(base, d, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (!data.fullText || !/^skip\s+to\s+(content|main)/i.test(data.fullText)) {
        skipped++;
        continue;
      }

      const originalLength = data.fullText.length;
      const cleaned = cleanText(data.fullText);
      const charsRemoved = originalLength - cleaned.length;

      if (charsRemoved === 0) {
        skipped++;
        continue;
      }

      // Re-classify content tier with cleaned text
      const tierResult = classifyContentTier({ ...data, fullText: cleaned });

      results.push({
        file: path.join(d, f),
        outlet: data.outletId,
        originalLength,
        cleanedLength: cleaned.length,
        charsRemoved,
        oldTier: data.contentTier || 'none',
        newTier: tierResult.contentTier,
        preview: cleaned.substring(0, 80) + '...',
      });

      if (!dryRun) {
        data.fullText = cleaned;
        data.contentTier = tierResult.contentTier;
        data.contentTierReason = tierResult.reason;
        if (data.needsRescore !== true && data.llmScore && !data.humanReviewScore) {
          data.needsRescore = true;
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      fixed++;
    } catch (e) {
      errors++;
    }
  }
}

console.log(`${dryRun ? '[DRY RUN] ' : ''}Fix nav-contaminated reviews:`);
console.log(`  Fixed: ${fixed}`);
console.log(`  Skipped: ${skipped}`);
console.log(`  Errors: ${errors}`);

if (results.length > 0) {
  // Group by outlet
  const byOutlet = {};
  for (const r of results) {
    byOutlet[r.outlet] = (byOutlet[r.outlet] || 0) + 1;
  }
  console.log('\nBy outlet:');
  for (const [outlet, count] of Object.entries(byOutlet).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outlet}: ${count}`);
  }

  console.log('\nSample results:');
  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.file}: ${r.originalLength} → ${r.cleanedLength} chars (-${r.charsRemoved}), tier: ${r.oldTier} → ${r.newTier}`);
    console.log(`    Preview: ${r.preview}`);
  }
}

if (dryRun && fixed > 0) {
  console.log(`\nRun with --apply to make changes.`);
}
