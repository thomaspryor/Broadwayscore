#!/usr/bin/env node
/**
 * Reclean Truncated Reviews
 *
 * Re-applies cleanText() and classifyContentTier() to all truncated review files.
 * Reviews that upgrade from truncated → complete are saved back to disk.
 *
 * Usage:
 *   node scripts/reclean-truncated.js              # Dry run (default)
 *   node scripts/reclean-truncated.js --apply       # Actually write changes
 */

const fs = require('fs');
const path = require('path');
const { cleanText } = require('./lib/text-cleaning');
const { classifyContentTier } = require('./lib/content-quality');

const base = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = !process.argv.includes('--apply');

if (dryRun) {
  console.log('=== DRY RUN MODE (use --apply to write changes) ===\n');
}

const stats = {
  scanned: 0,
  upgraded: 0,
  textChanged: 0,
  unchanged: 0,
  errors: 0,
};
const upgradedFiles = [];
const byDomain = {};

const dirs = fs.readdirSync(base).filter(d => {
  try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
});

for (const showDir of dirs) {
  const showPath = path.join(base, showDir);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(showPath, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const review = JSON.parse(raw);

      if (review.wrongProduction || review.wrongShow || review.wrongAttribution) continue;
      if (review.contentTier !== 'truncated') continue;
      if (!review.fullText) continue;

      stats.scanned++;

      const cleaned = cleanText(review.fullText);
      const textChanged = cleaned !== review.fullText;
      const result = classifyContentTier({ ...review, fullText: cleaned });

      if (result.contentTier === 'complete') {
        stats.upgraded++;
        if (textChanged) stats.textChanged++;

        let domain = 'no-url';
        if (review.url) {
          try { domain = new URL(review.url).hostname.replace('www.', ''); } catch {}
        }
        byDomain[domain] = (byDomain[domain] || 0) + 1;

        upgradedFiles.push({
          file: showDir + '/' + file,
          domain,
          charsBefore: review.fullText.length,
          charsAfter: cleaned.length,
          stripped: review.fullText.length - cleaned.length,
        });

        if (!dryRun) {
          // Preserve all fields, only update fullText, contentTier, and tierReason
          const updated = { ...review };
          updated.fullText = cleaned;
          updated.contentTier = result.contentTier;
          updated.tierReason = result.tierReason;
          updated.recleanedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n');
        }
      } else {
        stats.unchanged++;
      }
    } catch (e) {
      stats.errors++;
    }
  }
}

console.log(`Scanned: ${stats.scanned} truncated reviews`);
console.log(`Upgraded to complete: ${stats.upgraded}`);
console.log(`  (text also cleaned: ${stats.textChanged})`);
console.log(`Unchanged: ${stats.unchanged}`);
console.log(`Errors: ${stats.errors}`);

if (upgradedFiles.length > 0) {
  console.log('\n=== UPGRADED REVIEWS BY DOMAIN ===');
  Object.entries(byDomain).sort((a, b) => b[1] - a[1]).forEach(([d, c]) => {
    console.log(`  ${d}: ${c}`);
  });

  console.log('\n=== UPGRADED FILES ===');
  upgradedFiles.forEach(f => {
    const delta = f.stripped > 0 ? ` (stripped ${f.stripped} chars)` : '';
    console.log(`  ${f.file}${delta}`);
  });
}

if (dryRun && stats.upgraded > 0) {
  console.log(`\nRun with --apply to write ${stats.upgraded} changes to disk.`);
}
