#!/usr/bin/env node
/**
 * Convert Show Score extracted data to review-text files
 *
 * This takes the critic reviews from show-score.json and creates
 * individual review files in data/review-texts/{show-id}/
 */

const fs = require('fs');
const path = require('path');

const showScorePath = path.join(__dirname, '../data/show-score.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// UK/West End outlet patterns - skip these for Broadway shows
const UK_OUTLET_PATTERNS = [
  'guardian-uk', 'telegraph-uk', 'times-uk', 'independent-uk', 'stage-uk',
  'london-evening-standard', 'time-out-london', 'london-theatre',
  'whatsonstage', 'british-theatre-guide', 'west-end-best-friend'
];

function isUKOutlet(outletName) {
  if (!outletName) return false;
  const normalized = outletName.toLowerCase();
  return UK_OUTLET_PATTERNS.some(pattern => normalized.includes(pattern)) ||
         normalized.includes('london') ||
         normalized.includes(' uk') ||
         normalized.endsWith('-uk');
}

// Outlet name normalization
function normalizeOutletId(outletName) {
  if (!outletName) return 'unknown';

  const normalized = outletName.toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Map common variations
  const outletMap = {
    'new-york-times': 'nytimes',
    'ny-times': 'nytimes',
    'wall-street-journal': 'wsj',
    'hollywood-reporter': 'thr',
    'washington-post': 'wapo',
    'entertainment-weekly': 'ew',
    'new-york-post': 'nyp',
    'new-york-daily-news': 'nydn',
    'daily-news': 'nydn',
    'time-out-new-york': 'time-out-new-york',
    'timeout-new-york': 'time-out-new-york',
    'time-out': 'time-out-new-york',
    'new-york-stage-review': 'nysr',
    'new-york-theater': 'nyt-theater',
    'new-york-theatre-guide': 'nytg',
  };

  return outletMap[normalized] || normalized;
}

function normalizeCriticName(name) {
  if (!name) return 'unknown';
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function main() {
  console.log('Converting Show Score data to review-text files...\n');

  if (!fs.existsSync(showScorePath)) {
    console.log('ERROR: show-score.json not found. Run extract-show-score-reviews.js first.');
    process.exit(1);
  }

  const showScoreData = JSON.parse(fs.readFileSync(showScorePath, 'utf8'));
  const shows = showScoreData.shows || {};

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;

  for (const [showId, data] of Object.entries(shows)) {
    if (!data.criticReviews || data.criticReviews.length === 0) {
      continue;
    }

    console.log(`Processing: ${showId} (${data.criticReviews.length} critic reviews)`);

    // Ensure show directory exists
    const showDir = path.join(reviewTextsDir, showId);
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    for (const review of data.criticReviews) {
      // Skip UK/West End outlets for Broadway shows
      if (isUKOutlet(review.outlet)) {
        console.log(`  Skipped UK outlet: ${review.outlet}`);
        totalSkipped++;
        continue;
      }

      const outletId = normalizeOutletId(review.outlet);
      const criticId = normalizeCriticName(review.author);
      const filename = `${outletId}--${criticId}.json`;
      const filePath = path.join(showDir, filename);

      // Check if file already exists
      if (fs.existsSync(filePath)) {
        // Read existing file and check if we should update
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // If existing has better data (fullText or DTLI/BWW source), skip
        if (existing.fullText || existing.source === 'dtli' || existing.source === 'bww-roundup') {
          // Just add showScoreExcerpt if missing
          if (!existing.showScoreExcerpt && review.excerpt) {
            existing.showScoreExcerpt = review.excerpt;
            existing.showScoreUrl = data.showScoreUrl;
            if (!existing.url && review.url) {
              existing.url = review.url;
            }
            fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
            totalUpdated++;
          } else {
            totalSkipped++;
          }
          continue;
        }
      }

      // Create new review file
      const reviewData = {
        showId,
        outletId,
        outlet: review.outlet,
        criticName: review.author,
        url: review.url || null,
        publishDate: review.date || null,
        fullText: null,
        isFullReview: false,
        showScoreExcerpt: review.excerpt || null,
        showScoreUrl: data.showScoreUrl,
        originalScore: null,
        assignedScore: null,
        source: 'show-score',
        dtliThumb: null
      };

      fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2));
      console.log(`  Created: ${filename}`);
      totalCreated++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Created: ${totalCreated}`);
  console.log(`Updated (added excerpt): ${totalUpdated}`);
  console.log(`Skipped (better data exists): ${totalSkipped}`);
}

main();
