#!/usr/bin/env node
/**
 * Build Master Review List
 *
 * Merges reviews from all three aggregator sources (DTLI, BWW, Show Score)
 * and creates a deduplicated master list with best available data.
 *
 * Deduplication Logic:
 * 1. Same URL (exact match)
 * 2. Same outlet + critic (fuzzy name matching)
 * 3. Same outlet + similar excerpt (Levenshtein < 0.2)
 *
 * Usage:
 *   node scripts/build-master-review-list.js
 *   node scripts/build-master-review-list.js --show=hamilton-2015
 *   node scripts/build-master-review-list.js --rebuild
 */

const fs = require('fs');
const path = require('path');

// Paths
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const AGGREGATOR_SUMMARY_PATH = path.join(__dirname, '..', 'data', 'aggregator-summary.json');
const MASTER_LIST_PATH = path.join(__dirname, '..', 'data', 'master-review-list.json');

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  // Create a matrix
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Calculate normalized Levenshtein similarity (0 = different, 1 = same)
 */
function levenshteinSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  return 1 - (levenshteinDistance(str1, str2) / maxLen);
}

/**
 * Normalize critic name for comparison
 */
function normalizeCriticName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize excerpt for comparison (first 100 chars)
 */
function normalizeExcerpt(excerpt) {
  if (!excerpt) return '';
  return excerpt.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

/**
 * Slugify a string
 */
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load shows data
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * Load aggregator summary
 */
function loadAggregatorSummary() {
  if (fs.existsSync(AGGREGATOR_SUMMARY_PATH)) {
    return JSON.parse(fs.readFileSync(AGGREGATOR_SUMMARY_PATH, 'utf8'));
  }
  return { dtli: {}, bww: {}, showScore: {} };
}

/**
 * Load all reviews for a show from review-texts directory
 */
function loadShowReviews(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const reviews = [];

  if (!fs.existsSync(showDir)) {
    return reviews;
  }

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    try {
      const reviewPath = path.join(showDir, file);
      const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      reviews.push({
        ...review,
        _filename: file
      });
    } catch (e) {
      console.warn(`  Warning: Could not parse ${showId}/${file}: ${e.message}`);
    }
  }

  return reviews;
}

/**
 * Check if two reviews are likely the same
 */
function isSameReview(review1, review2) {
  // 1. Same URL (exact match)
  if (review1.url && review2.url && review1.url === review2.url) {
    return true;
  }

  // 2. Same outlet + critic (fuzzy name matching)
  if (review1.outletId === review2.outletId) {
    const name1 = normalizeCriticName(review1.criticName);
    const name2 = normalizeCriticName(review2.criticName);

    if (name1 && name2 && levenshteinSimilarity(name1, name2) > 0.85) {
      return true;
    }
  }

  // 3. Same outlet + similar excerpt (Levenshtein > 0.8)
  if (review1.outletId === review2.outletId) {
    const excerpt1 = normalizeExcerpt(review1.dtliExcerpt || review1.bwwExcerpt || review1.showScoreExcerpt || review1.fullText);
    const excerpt2 = normalizeExcerpt(review2.dtliExcerpt || review2.bwwExcerpt || review2.showScoreExcerpt || review2.fullText);

    if (excerpt1 && excerpt2 && excerpt1.length > 20 && excerpt2.length > 20) {
      if (levenshteinSimilarity(excerpt1, excerpt2) > 0.8) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Merge two reviews, keeping best data from each
 */
function mergeReviews(existing, newReview) {
  const merged = { ...existing };

  // URL: Prefer non-null
  if (!merged.url && newReview.url) {
    merged.url = newReview.url;
  }

  // Critic name: Prefer non-Unknown
  if ((merged.criticName === 'Unknown' || !merged.criticName) && newReview.criticName && newReview.criticName !== 'Unknown') {
    merged.criticName = newReview.criticName;
  }

  // Date: Prefer non-null
  if (!merged.publishDate && newReview.publishDate) {
    merged.publishDate = newReview.publishDate;
  }

  // DTLI data
  if (!merged.dtliExcerpt && newReview.dtliExcerpt) {
    merged.dtliExcerpt = newReview.dtliExcerpt;
  }
  if (!merged.dtliThumb && newReview.dtliThumb) {
    merged.dtliThumb = newReview.dtliThumb;
  }
  if (!merged.dtliUrl && newReview.dtliUrl) {
    merged.dtliUrl = newReview.dtliUrl;
  }

  // BWW data
  if (!merged.bwwExcerpt && newReview.bwwExcerpt) {
    merged.bwwExcerpt = newReview.bwwExcerpt;
  }
  if (!merged.bwwRoundupUrl && newReview.bwwRoundupUrl) {
    merged.bwwRoundupUrl = newReview.bwwRoundupUrl;
  }
  if (!merged.bwwUrl && newReview.bwwUrl) {
    merged.bwwUrl = newReview.bwwUrl;
  }

  // Show Score data
  if (!merged.showScoreExcerpt && newReview.showScoreExcerpt) {
    merged.showScoreExcerpt = newReview.showScoreExcerpt;
  }

  // Full text: Prefer longer version
  if (newReview.fullText) {
    if (!merged.fullText || newReview.fullText.length > merged.fullText.length) {
      merged.fullText = newReview.fullText;
      merged.isFullReview = newReview.isFullReview;
    }
  }

  // Original score: Prefer non-null
  if (!merged.originalScore && newReview.originalScore) {
    merged.originalScore = newReview.originalScore;
  }
  if (!merged.originalRating && newReview.originalRating) {
    merged.originalRating = newReview.originalRating;
  }

  // Track sources
  if (!merged._sources) {
    merged._sources = [];
  }
  if (newReview.source && !merged._sources.includes(newReview.source)) {
    merged._sources.push(newReview.source);
  }

  return merged;
}

/**
 * Build master review list for a single show
 */
function buildMasterListForShow(showId, existingReviews = []) {
  const masterReviews = [];

  // Process each existing review
  for (const review of existingReviews) {
    // Find if this review matches any in our master list
    let found = false;

    for (let i = 0; i < masterReviews.length; i++) {
      if (isSameReview(masterReviews[i], review)) {
        // Merge data
        masterReviews[i] = mergeReviews(masterReviews[i], review);
        found = true;
        break;
      }
    }

    if (!found) {
      // Add as new master review
      masterReviews.push({
        showId: review.showId,
        outletId: review.outletId,
        outlet: review.outlet,
        criticName: review.criticName || 'Unknown',
        url: review.url || null,
        publishDate: review.publishDate || null,
        fullText: review.fullText || null,
        isFullReview: review.isFullReview || false,
        dtliExcerpt: review.dtliExcerpt || null,
        dtliThumb: review.dtliThumb || null,
        dtliUrl: review.dtliUrl || null,
        bwwExcerpt: review.bwwExcerpt || null,
        bwwRoundupUrl: review.bwwRoundupUrl || null,
        bwwUrl: review.bwwUrl || null,
        showScoreExcerpt: review.showScoreExcerpt || null,
        originalScore: review.originalScore || null,
        originalRating: review.originalRating || null,
        assignedScore: review.assignedScore || null,
        source: review.source || 'unknown',
        _sources: [review.source || 'unknown'],
        needsText: !review.fullText,
        needsScoring: review.needsScoring !== false && !review.assignedScore
      });
    }
  }

  // Determine best URL for each review
  for (const review of masterReviews) {
    review.bestUrl = review.url || review.bwwUrl || null;
  }

  return masterReviews;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const showArg = args.find(a => a.startsWith('--show='));
  const rebuild = args.includes('--rebuild');

  console.log('========================================');
  console.log('Build Master Review List');
  console.log('========================================');

  const shows = loadShows();
  const aggregatorSummary = loadAggregatorSummary();

  let showsToProcess = [];

  if (showArg) {
    const showId = showArg.replace('--show=', '');
    const show = shows.find(s => s.id === showId);
    if (!show) {
      console.error(`Show not found: ${showId}`);
      process.exit(1);
    }
    showsToProcess = [show];
  } else {
    // Process all shows with review data
    const showDirs = fs.existsSync(REVIEW_TEXTS_DIR) ? fs.readdirSync(REVIEW_TEXTS_DIR) : [];
    showsToProcess = shows.filter(s => showDirs.includes(s.id));
  }

  console.log(`Shows to process: ${showsToProcess.length}`);

  // Load existing master list (unless rebuilding)
  let masterList = {};
  if (!rebuild && fs.existsSync(MASTER_LIST_PATH)) {
    masterList = JSON.parse(fs.readFileSync(MASTER_LIST_PATH, 'utf8'));
  }

  let totalReviews = 0;
  let totalDeduplicated = 0;
  let totalWithUrls = 0;
  let totalWithText = 0;
  let duplicatesRemoved = 0;

  for (const show of showsToProcess) {
    process.stdout.write(`Processing ${show.id}... `);

    const reviews = loadShowReviews(show.id);
    const originalCount = reviews.length;

    if (reviews.length === 0) {
      console.log('no reviews found');
      continue;
    }

    // Build master list for this show
    const masterReviews = buildMasterListForShow(show.id, reviews);
    const deduplicatedCount = masterReviews.length;
    duplicatesRemoved += (originalCount - deduplicatedCount);

    // Count stats
    const withUrls = masterReviews.filter(r => r.bestUrl).length;
    const withText = masterReviews.filter(r => r.fullText && r.fullText.length > 200).length;

    // Get aggregator counts
    const dtliCounts = aggregatorSummary.dtli?.[show.id] || { up: 0, meh: 0, down: 0 };
    const bwwCounts = aggregatorSummary.bww?.[show.id] || { totalReviews: 0 };
    const showScoreCounts = aggregatorSummary.showScore?.[show.id] || { totalReviews: 0 };

    masterList[show.id] = {
      title: show.title,
      reviews: masterReviews,
      stats: {
        totalReviews: masterReviews.length,
        withUrls: withUrls,
        withText: withText,
        needsText: masterReviews.length - withText,
        needsScoring: masterReviews.filter(r => r.needsScoring).length
      },
      aggregatorCounts: {
        dtli: { up: dtliCounts.up, meh: dtliCounts.meh, down: dtliCounts.down, total: dtliCounts.up + dtliCounts.meh + dtliCounts.down },
        bww: { total: bwwCounts.totalReviews },
        showScore: { total: showScoreCounts.totalReviews }
      },
      lastUpdated: new Date().toISOString()
    };

    totalReviews += originalCount;
    totalDeduplicated += deduplicatedCount;
    totalWithUrls += withUrls;
    totalWithText += withText;

    console.log(`${originalCount} -> ${deduplicatedCount} reviews (${withUrls} URLs, ${withText} with text)`);
  }

  // Add metadata
  masterList._meta = {
    lastUpdated: new Date().toISOString(),
    totalShows: Object.keys(masterList).filter(k => k !== '_meta').length,
    totalReviews: totalDeduplicated,
    totalWithUrls: totalWithUrls,
    totalWithText: totalWithText,
    duplicatesRemoved: duplicatesRemoved,
    deduplicationRate: totalReviews > 0 ? ((totalReviews - totalDeduplicated) / totalReviews * 100).toFixed(1) + '%' : '0%'
  };

  // Save master list
  fs.writeFileSync(MASTER_LIST_PATH, JSON.stringify(masterList, null, 2));

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Shows processed: ${showsToProcess.length}`);
  console.log(`Total input reviews: ${totalReviews}`);
  console.log(`Deduplicated reviews: ${totalDeduplicated}`);
  console.log(`Duplicates removed: ${duplicatesRemoved} (${masterList._meta.deduplicationRate})`);
  console.log(`Reviews with URLs: ${totalWithUrls}`);
  console.log(`Reviews with full text: ${totalWithText}`);
  console.log(`\nSaved to: ${MASTER_LIST_PATH}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
