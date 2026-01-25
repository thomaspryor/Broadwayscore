#!/usr/bin/env node
/**
 * Mark reviews that can't be scored as "TO_BE_CALCULATED"
 * These will be EXCLUDED from scoring until we have real data
 *
 * NEVER use a default score of 50 - that skews results
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Track stats
const stats = {
  total: 0,
  markedUncalculated: 0,
  byShow: {}
};

const uncalculatedReviews = [];

// Process all shows
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Check if this review has a valid score source
      const hasLlmScore = data.llmScore?.score && data.llmScore?.confidence !== 'low' && !data.ensembleData?.needsReview;
      const hasAssignedScore = data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100 && data.scoreSource !== 'default';
      const hasOriginalScore = data.originalScore;
      const hasBucket = data.bucket;
      const hasThumb = data.dtliThumb || data.bwwThumb || data.thumb;

      // If we previously set a sentiment-based score, that's valid
      const hasSentimentScore = data.scoreSource && data.scoreSource.startsWith('sentiment');

      const hasValidScore = hasLlmScore || hasAssignedScore || hasOriginalScore || hasBucket || hasThumb || hasSentimentScore;

      if (!hasValidScore) {
        stats.total++;

        // Mark as TO_BE_CALCULATED
        data.assignedScore = null;
        data.scoreStatus = 'TO_BE_CALCULATED';
        data.scoreSource = null;

        // Remove any default bucket/thumb that might have been set
        if (!data.dtliThumb && !data.bwwThumb) {
          delete data.bucket;
          delete data.thumb;
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        stats.markedUncalculated++;

        stats.byShow[showId] = (stats.byShow[showId] || 0) + 1;

        uncalculatedReviews.push({
          showId,
          file,
          outlet: data.outlet,
          critic: data.criticName,
          hasText: !!(data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt),
          url: data.url
        });

        console.log(`⚠ ${showId}/${file}: Marked TO_BE_CALCULATED (${data.outlet})`);
      }
    } catch(e) {
      console.error(`Error processing ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total reviews marked TO_BE_CALCULATED: ${stats.markedUncalculated}`);
console.log('\nThese reviews will be EXCLUDED from scoring until we have real data.');

console.log('\n=== BY SHOW ===');
Object.entries(stats.byShow)
  .sort((a, b) => b[1] - a[1])
  .forEach(([show, count]) => {
    console.log(`  ${show}: ${count}`);
  });

// Save list for reference
const reportPath = path.join(__dirname, '../data/audit/uncalculated-reviews.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: stats.markedUncalculated,
  byShow: stats.byShow,
  reviews: uncalculatedReviews
}, null, 2));

console.log(`\nReport saved to: ${reportPath}`);
console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
console.log('(It will now EXCLUDE these reviews from reviews.json)');
