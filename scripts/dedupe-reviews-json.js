#!/usr/bin/env node

/**
 * Deduplicate reviews.json - Ensure ONE review per outlet+critic combo per show
 *
 * CRITICAL FIX: This script removes duplicate outlet+critic entries that were
 * incorrectly added by web search collection.
 *
 * NOTE: Multiple reviews per outlet ARE allowed if they're from different critics.
 * E.g., NYT could have both Jesse Green and Maya Phillips review the same show.
 * But there should never be TWO Jesse Green NYT reviews for the same show.
 *
 * Selection criteria when duplicates exist:
 * 1. Prefer review with fullText over excerpt-only
 * 2. Prefer review with assignedScore over null score
 * 3. Prefer review from aggregator source over web-search
 * 4. If still tied, keep the first one encountered
 *
 * Usage: node scripts/dedupe-reviews-json.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REVIEWS_PATH = path.join(__dirname, '../data/reviews.json');
const dryRun = process.argv.includes('--dry-run');

console.log('=== Deduplicate reviews.json ===');
console.log('Mode:', dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify file)');
console.log('');

// Load reviews
const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
const reviews = reviewsData.reviews;

console.log('Total reviews before:', reviews.length);

// Group by show
const byShow = {};
reviews.forEach(r => {
  byShow[r.showId] = byShow[r.showId] || [];
  byShow[r.showId].push(r);
});

// Score a review for quality (higher = better to keep)
function scoreReview(r) {
  let score = 0;

  // Has full text
  if (r.fullText && r.fullText.length > 200) score += 100;

  // Has assigned score
  if (r.assignedScore !== null && r.assignedScore !== undefined) score += 50;

  // Has LLM score
  if (r.llmScore) score += 30;

  // Prefer aggregator sources over web-search
  const source = r.source || '';
  if (source.includes('dtli') || source.includes('bww') || source.includes('show-score')) {
    score += 20;
  } else if (source === 'web-search') {
    score -= 10; // Penalize web-search (more likely to be misattributed)
  }

  // Has URL
  if (r.url) score += 10;

  return score;
}

// Deduplicate
const deduped = [];
let removedCount = 0;
const removedDetails = [];

Object.entries(byShow).forEach(([showId, showReviews]) => {
  const byOutletCritic = {};

  showReviews.forEach(r => {
    // Normalize outlet AND critic for comparison
    // Key is outlet|critic so different critics at same outlet are allowed
    const outletKey = (r.outlet || 'unknown').toLowerCase().trim();
    const criticKey = (r.criticName || 'unknown').toLowerCase().trim();
    const key = `${outletKey}|${criticKey}`;

    if (!byOutletCritic[key]) {
      byOutletCritic[key] = r;
    } else {
      // Duplicate found - same outlet AND same critic
      const existing = byOutletCritic[key];
      const existingScore = scoreReview(existing);
      const newScore = scoreReview(r);

      if (newScore > existingScore) {
        // New one is better, replace
        removedDetails.push({
          showId,
          outlet: existing.outlet,
          critic: existing.criticName,
          reason: `Replaced by better quality review (score ${existingScore} -> ${newScore})`
        });
        byOutletCritic[key] = r;
      } else {
        // Existing is better or equal, discard new
        removedDetails.push({
          showId,
          outlet: r.outlet,
          critic: r.criticName,
          reason: `Duplicate outlet+critic (kept review with score ${existingScore})`
        });
      }
      removedCount++;
    }
  });

  // Add deduplicated reviews for this show
  Object.values(byOutletCritic).forEach(r => deduped.push(r));
});

console.log('Reviews removed:', removedCount);
console.log('Reviews after dedup:', deduped.length);
console.log('');

// Show sample of removed reviews
console.log('Sample of removed reviews:');
removedDetails.slice(0, 10).forEach(d => {
  console.log(`  ${d.showId}: ${d.outlet} (${d.critic}) - ${d.reason}`);
});
if (removedDetails.length > 10) {
  console.log(`  ... and ${removedDetails.length - 10} more`);
}

if (!dryRun) {
  // Sort deduped reviews by showId, then outlet
  deduped.sort((a, b) => {
    if (a.showId !== b.showId) return a.showId.localeCompare(b.showId);
    return (a.outlet || '').localeCompare(b.outlet || '');
  });

  // Save
  reviewsData.reviews = deduped;
  reviewsData._meta = reviewsData._meta || {};
  reviewsData._meta.lastDeduped = new Date().toISOString();
  reviewsData._meta.dedupedCount = removedCount;

  fs.writeFileSync(REVIEWS_PATH, JSON.stringify(reviewsData, null, 2));
  console.log('');
  console.log('✅ Saved deduplicated reviews.json');

  // Also save removal log
  const logPath = path.join(__dirname, '../data/audit/dedup-log.json');
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  fs.writeFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    removedCount,
    beforeCount: reviews.length,
    afterCount: deduped.length,
    removed: removedDetails
  }, null, 2));
  console.log('✅ Saved removal log to data/audit/dedup-log.json');
} else {
  console.log('');
  console.log('DRY RUN - no changes made. Run without --dry-run to apply.');
}
