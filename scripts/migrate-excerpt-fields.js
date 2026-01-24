#!/usr/bin/env node
/**
 * Migrate review files to add separate excerpt fields:
 * - isFullReview: boolean indicating if fullText is a complete review
 * - dtliExcerpt: excerpt from Did They Like It
 * - bwwExcerpt: excerpt from BroadwayWorld Review Roundup
 * - showScoreExcerpt: excerpt from Show Score
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const SHOW_SCORE_PATH = path.join(__dirname, '../data/show-score.json');

// Threshold for considering text a full review vs excerpt
const FULL_REVIEW_MIN_CHARS = 500;

// Load Show Score data
let showScoreData = { shows: {} };
if (fs.existsSync(SHOW_SCORE_PATH)) {
  showScoreData = JSON.parse(fs.readFileSync(SHOW_SCORE_PATH, 'utf8'));
}

// Normalize outlet names for matching
function normalizeOutlet(outlet) {
  if (!outlet) return '';
  return outlet
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Normalize critic names for matching
function normalizeCritic(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Find Show Score excerpt for a review
function findShowScoreExcerpt(showId, outlet, criticName) {
  const showData = showScoreData.shows[showId];
  if (!showData || !showData.criticReviews) return null;

  const normalizedOutlet = normalizeOutlet(outlet);
  const normalizedCritic = normalizeCritic(criticName);

  for (const review of showData.criticReviews) {
    const reviewOutlet = normalizeOutlet(review.outlet);
    const reviewCritic = normalizeCritic(review.author);

    // Match by outlet and optionally critic
    if (reviewOutlet.includes(normalizedOutlet) || normalizedOutlet.includes(reviewOutlet)) {
      // If critic names are available, check they match
      if (normalizedCritic && reviewCritic) {
        if (reviewCritic.includes(normalizedCritic) || normalizedCritic.includes(reviewCritic)) {
          return review.excerpt;
        }
      } else {
        // If no critic name to match, use outlet match
        return review.excerpt;
      }
    }
  }

  return null;
}

// Determine if a source indicates scraped/full content
function isScrapedSource(source) {
  if (!source) return false;
  const scrapedSources = ['playwright-scraped', 'webfetch-scraped', 'scraped', 'manual'];
  return scrapedSources.includes(source);
}

// Process a single review file
function processReviewFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let review;

  try {
    review = JSON.parse(content);
  } catch (e) {
    console.error(`Failed to parse ${filePath}: ${e.message}`);
    return { updated: false };
  }

  const source = review.source || '';
  const fullText = review.fullText || '';
  const fullTextLength = fullText.length;

  let changes = [];

  // Determine isFullReview
  // Full review if: scraped source AND text > 500 chars
  // OR reviews-json-stub with substantial text (these are sometimes full reviews)
  const wasScraped = isScrapedSource(source);
  const hasSubstantialText = fullTextLength >= FULL_REVIEW_MIN_CHARS;

  // If already has isFullReview field, preserve it
  if (review.isFullReview === undefined) {
    if (wasScraped && hasSubstantialText) {
      review.isFullReview = true;
      changes.push('isFullReview=true');
    } else if (source === 'bww-roundup' || source === 'dtli') {
      review.isFullReview = false;
      changes.push('isFullReview=false');
    } else if (hasSubstantialText) {
      // Other sources with substantial text - likely full review
      review.isFullReview = true;
      changes.push('isFullReview=true');
    } else if (fullText) {
      review.isFullReview = false;
      changes.push('isFullReview=false');
    }
  }

  // Handle DTLI excerpt
  if (source === 'dtli' && fullText && !review.dtliExcerpt) {
    review.dtliExcerpt = fullText;
    // Clear fullText since it's just an excerpt
    review.fullText = null;
    changes.push('moved fullText→dtliExcerpt');
  }

  // Handle BWW excerpt
  if (source === 'bww-roundup' && fullText && !review.bwwExcerpt) {
    review.bwwExcerpt = fullText;
    // Clear fullText since it's just an excerpt
    review.fullText = null;
    changes.push('moved fullText→bwwExcerpt');
  }

  // Try to find Show Score excerpt
  if (!review.showScoreExcerpt) {
    const ssExcerpt = findShowScoreExcerpt(review.showId, review.outlet, review.criticName);
    if (ssExcerpt) {
      review.showScoreExcerpt = ssExcerpt;
      changes.push('added showScoreExcerpt');
    }
  }

  if (changes.length > 0) {
    // Reorder fields for cleaner output
    const orderedReview = {
      showId: review.showId,
      outletId: review.outletId,
      outlet: review.outlet,
      criticName: review.criticName,
      url: review.url,
      publishDate: review.publishDate,
      fullText: review.fullText,
      isFullReview: review.isFullReview,
      dtliExcerpt: review.dtliExcerpt,
      bwwExcerpt: review.bwwExcerpt,
      showScoreExcerpt: review.showScoreExcerpt,
      originalScore: review.originalScore,
      assignedScore: review.assignedScore,
      source: review.source,
      ...review  // Include any other fields
    };

    // Remove undefined fields
    Object.keys(orderedReview).forEach(key => {
      if (orderedReview[key] === undefined) {
        delete orderedReview[key];
      }
    });

    fs.writeFileSync(filePath, JSON.stringify(orderedReview, null, 2) + '\n');
    return { updated: true, changes };
  }

  return { updated: false };
}

// Main
function main() {
  const stats = {
    total: 0,
    updated: 0,
    errors: 0,
    dtliExcerpts: 0,
    bwwExcerpts: 0,
    showScoreExcerpts: 0,
    fullReviews: 0
  };

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showPath, file);
      stats.total++;

      try {
        const result = processReviewFile(filePath);
        if (result.updated) {
          stats.updated++;
          if (result.changes.includes('moved fullText→dtliExcerpt')) stats.dtliExcerpts++;
          if (result.changes.includes('moved fullText→bwwExcerpt')) stats.bwwExcerpts++;
          if (result.changes.includes('added showScoreExcerpt')) stats.showScoreExcerpts++;
          if (result.changes.includes('isFullReview=true')) stats.fullReviews++;
          console.log(`Updated: ${showDir}/${file} - ${result.changes.join(', ')}`);
        }
      } catch (e) {
        stats.errors++;
        console.error(`Error processing ${filePath}: ${e.message}`);
      }
    }
  }

  console.log('\n=== Migration Summary ===');
  console.log(`Total files: ${stats.total}`);
  console.log(`Updated: ${stats.updated}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`DTLI excerpts moved: ${stats.dtliExcerpts}`);
  console.log(`BWW excerpts moved: ${stats.bwwExcerpts}`);
  console.log(`Show Score excerpts added: ${stats.showScoreExcerpts}`);
  console.log(`Marked as full reviews: ${stats.fullReviews}`);
}

main();
