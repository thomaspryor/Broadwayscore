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
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewKey,
  areCriticsSimilar,
  areOutletsSame,
  getOutletDisplayName,
} = require('./lib/review-normalization');

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
 * Check if two critic names likely refer to the same person
 * Handles cases like "Jesse" vs "Jesse Green", partial names, etc.
 */
function isSameCritic(name1, name2) {
  const n1 = normalizeCriticName(name1);
  const n2 = normalizeCriticName(name2);

  // Both empty or unknown
  if (!n1 || !n2 || n1 === 'unknown' || n2 === 'unknown') {
    return false;
  }

  // Exact match
  if (n1 === n2) return true;

  // One contains the other (handles "Jesse" vs "Jesse Green")
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // First name matches (handles "Jesse" vs "Jesse Green")
  const words1 = n1.split(' ');
  const words2 = n2.split(' ');
  if (words1[0] === words2[0] && words1[0].length > 2) return true;

  // Last name matches (handles "Green" vs "Jesse Green")
  if (words1.length > 0 && words2.length > 0) {
    const last1 = words1[words1.length - 1];
    const last2 = words2[words2.length - 1];
    if (last1 === last2 && last1.length > 3) return true;
  }

  // High Levenshtein similarity (handles typos)
  if (levenshteinSimilarity(n1, n2) > 0.85) return true;

  return false;
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
 * Normalize outlet ID to canonical form for deduplication
 * Maps all variants of the same outlet to a single ID
 */
const OUTLET_ID_CANONICALIZATION = {
  // New York Times variants
  'nyt': 'nytimes',
  'new-york-times': 'nytimes',
  'nytimes-com': 'nytimes',
  'nyt-theater': 'nytimes',
  'nyth': 'nytimes',
  'nythtr': 'nytimes',
  'the-new-york-times': 'nytimes',

  // NY Post variants
  'ny-post': 'nypost',
  'new-york-post': 'nypost',
  'nyp': 'nypost',
  'nypost-com': 'nypost',
  'the-new-york-post': 'nypost',

  // Vulture / NY Magazine variants
  'vulture-com': 'vulture',
  'new-york-magazine-vulture': 'vulture',
  'ny-magazine': 'vulture',
  'ny-mag': 'vulture',
  'nymag': 'vulture',

  // NY Daily News variants
  'nydn': 'ny-daily-news',
  'new-york-daily-news': 'ny-daily-news',
  'nydailynews': 'ny-daily-news',
  'nydailynews-com': 'ny-daily-news',
  'daily-news': 'ny-daily-news',

  // NY Theatre Guide variants
  'nytg': 'ny-theatre-guide',
  'new-york-theatre-guide': 'ny-theatre-guide',
  'nytheatreguide': 'ny-theatre-guide',
  'newyorktheatreguide-com': 'ny-theatre-guide',

  // NY Stage Review variants
  'nysr': 'ny-stage-review',
  'new-york-stage-review': 'ny-stage-review',
  'nystagereview-com': 'ny-stage-review',

  // Hollywood Reporter variants
  'hr': 'hollywood-reporter',
  'the-hollywood-reporter': 'hollywood-reporter',
  'hollywoodreporter': 'hollywood-reporter',
  'hollywoodreporter-com': 'hollywood-reporter',

  // Deadline variants
  'deadline-com': 'deadline',
  'deadline-hollywood': 'deadline',

  // Entertainment Weekly variants
  'entertainment-weekly': 'ew',
  'ew-com': 'ew',

  // Time Out variants
  'time-out-new-york': 'timeout-ny',
  'time-out': 'timeout-ny',
  'timeout': 'timeout-ny',
  'timeout-com': 'timeout-ny',
  'timeoutny': 'timeout-ny',

  // Variety variants
  'variety-com': 'variety',

  // TheaterMania variants
  'theater-mania': 'theatermania',
  'theatermania-com': 'theatermania',

  // The Wrap variants
  'the-wrap': 'thewrap',
  'thewrap-com': 'thewrap',

  // Wall Street Journal variants
  'wall-street-journal': 'wsj',
  'the-wall-street-journal': 'wsj',
  'wsj-com': 'wsj',

  // Washington Post variants
  'washington-post': 'washpost',
  'the-washington-post': 'washpost',
  'washingtonpost-com': 'washpost',
  'wapo': 'washpost',

  // Guardian variants
  'the-guardian': 'guardian',
  'guardian-com': 'guardian',

  // Daily Beast variants
  'the-daily-beast': 'daily-beast',
  'thedailybeast': 'daily-beast',
  'dailybeast-com': 'daily-beast',

  // New Yorker variants
  'the-new-yorker': 'new-yorker',
  'newyorker': 'new-yorker',
  'newyorker-com': 'new-yorker',

  // Observer variants
  'the-observer': 'observer',
  'observer-com': 'observer',

  // amNewYork variants
  'am-new-york': 'amny',
  'amnewyork': 'amny',

  // Associated Press variants
  'associated-press': 'ap',

  // Broadway News variants
  'broadwaynews': 'broadway-news',
  'broadwaynews-com': 'broadway-news',

  // BroadwayWorld variants
  'broadway-world': 'broadwayworld',
  'broadwayworld-com': 'broadwayworld',

  // Theatrely variants
  'theatrely-com': 'theatrely',

  // USA Today variants
  'usa-today': 'usatoday',
  'usatoday-com': 'usatoday',

  // Chicago Tribune variants
  'chitrib': 'chicago-tribune',
  'chicagotribune': 'chicago-tribune',

  // LA Times variants
  'la-times': 'latimes',
  'los-angeles-times': 'latimes',
  'the-la-times': 'latimes',

  // Slant variants
  'slant-magazine': 'slant',
  'slantmagazine-com': 'slant',

  // CultureSauce variants
  'culture-sauce': 'culturesauce',
  'culturesauce-com': 'culturesauce',

  // Cititour variants
  'citi-tour': 'cititour',
  'cititour-com': 'cititour',
};

function normalizeOutletId(outletId) {
  if (!outletId) return 'unknown';
  const normalized = outletId.toLowerCase().trim();
  return OUTLET_ID_CANONICALIZATION[normalized] || normalized;
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
 * Uses centralized normalization for consistent matching
 */
function isSameReview(review1, review2) {
  // Use centralized normalization for consistent outlet matching
  const outlet1 = normalizeOutlet(review1.outlet || review1.outletId);
  const outlet2 = normalizeOutlet(review2.outlet || review2.outletId);

  // 1. Same URL (exact match)
  if (review1.url && review2.url && review1.url === review2.url) {
    return true;
  }

  // 2. Same normalized key (outlet + critic)
  const key1 = generateReviewKey(review1.outlet || review1.outletId, review1.criticName);
  const key2 = generateReviewKey(review2.outlet || review2.outletId, review2.criticName);
  if (key1 === key2) {
    return true;
  }

  // 3. Same outlet + similar critic (using centralized matching)
  if (outlet1 === outlet2) {
    if (areCriticsSimilar(review1.criticName, review2.criticName)) {
      return true;
    }

    // If one has Unknown critic, check excerpt similarity
    const critic1 = normalizeCritic(review1.criticName);
    const critic2 = normalizeCritic(review2.criticName);
    const hasUnknown1 = !critic1 || critic1 === 'unknown';
    const hasUnknown2 = !critic2 || critic2 === 'unknown';

    if (hasUnknown1 || hasUnknown2) {
      const excerpt1 = normalizeExcerpt(review1.dtliExcerpt || review1.bwwExcerpt || review1.showScoreExcerpt || review1.fullText);
      const excerpt2 = normalizeExcerpt(review2.dtliExcerpt || review2.bwwExcerpt || review2.showScoreExcerpt || review2.fullText);
      if (excerpt1 && excerpt2 && excerpt1.length > 20 && excerpt2.length > 20) {
        if (levenshteinSimilarity(excerpt1, excerpt2) > 0.5) {
          return true;
        }
      }
    }
  }

  // 4. Same outlet + similar excerpt (handles different critic name spellings)
  if (outlet1 === outlet2) {
    const excerpt1 = normalizeExcerpt(review1.dtliExcerpt || review1.bwwExcerpt || review1.showScoreExcerpt || review1.fullText);
    const excerpt2 = normalizeExcerpt(review2.dtliExcerpt || review2.bwwExcerpt || review2.showScoreExcerpt || review2.fullText);

    if (excerpt1 && excerpt2 && excerpt1.length > 20 && excerpt2.length > 20) {
      if (levenshteinSimilarity(excerpt1, excerpt2) > 0.7) {
        return true;
      }
    }
  }

  // 5. Same outlet + same fullText start (most reliable for identifying duplicates)
  if (outlet1 === outlet2 && review1.fullText && review2.fullText) {
    const ft1 = normalizeExcerpt(review1.fullText);
    const ft2 = normalizeExcerpt(review2.fullText);

    if (ft1 && ft2 && ft1.length > 30 && ft2.length > 30) {
      if (levenshteinSimilarity(ft1, ft2) > 0.8) {
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
        needsScoring: !review.assignedScore && !review.llmScore
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
