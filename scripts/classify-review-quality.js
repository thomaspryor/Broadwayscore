#!/usr/bin/env node
/**
 * classify-review-quality.js
 *
 * Classifies all review files with textQuality and sourceMethod fields.
 * Generates a coverage report showing progress toward 80% full text goal.
 *
 * Classification rules:
 * - full: >1500 chars AND mentions show title AND >300 words
 * - partial: 500-1500 chars OR mentions show title but <300 words
 * - excerpt: <500 chars (pull quotes from aggregators)
 * - missing: No text yet (empty or null fullText)
 *
 * Usage: node scripts/classify-review-quality.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const REPORT_FILE = path.join(__dirname, '..', 'data', 'text-coverage-report.json');

// Minimum thresholds
const FULL_TEXT_MIN_CHARS = 1500;
const FULL_TEXT_MIN_WORDS = 300;
const PARTIAL_MIN_CHARS = 500;
const EXCERPT_MAX_CHARS = 500;

// Map existing source values to standardized sourceMethod
const SOURCE_METHOD_MAP = {
  'playwright-scraped': 'playwright',
  'playwright': 'playwright',
  'playwright-stealth': 'playwright',
  'webfetch-scraped': 'webfetch',
  'webfetch': 'webfetch',
  'scrapingbee': 'scrapingbee',
  'scrapingbee-scraped': 'scrapingbee',
  'brightdata': 'brightdata',
  'dtli': 'dtli',
  'show-score': 'showscore',
  'showscore': 'showscore',
  'bww-roundup': 'bww-roundup',
  'archive': 'archive',
  'archive.org': 'archive',
  'web-search': 'web-search',
  'reviews-json-stub': 'stub',
  'manual': 'manual',
  'scraped': 'playwright', // Legacy scraped entries were mostly playwright
  'hadestown-official-site': 'manual',
  'playbill-roundup': 'bww-roundup',
};

function loadShowTitles() {
  const rawData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const showsData = rawData.shows || rawData; // Handle both {shows: [...]} and [...] formats
  const titleMap = {};

  for (const show of showsData) {
    // Store multiple variations of the title for matching
    const title = show.title.toLowerCase();
    titleMap[show.id] = {
      title: show.title,
      titleLower: title,
      // Create variations for matching (e.g., "Hamilton" matches "Hamilton")
      keywords: title.split(/[:\-–—]/).map(s => s.trim()).filter(s => s.length > 2)
    };
  }

  return titleMap;
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function mentionsShowTitle(text, showInfo) {
  if (!text || !showInfo) return false;

  const textLower = text.toLowerCase();

  // Check if main title is mentioned
  if (textLower.includes(showInfo.titleLower)) {
    return true;
  }

  // Check if any significant keyword from title is mentioned (min 4 chars)
  for (const keyword of showInfo.keywords) {
    if (keyword.length >= 4 && textLower.includes(keyword)) {
      return true;
    }
  }

  return false;
}

function classifyTextQuality(review, showInfo) {
  const fullText = review.fullText;

  // Missing: no text at all
  if (!fullText || fullText.trim().length === 0) {
    return 'missing';
  }

  const charCount = fullText.length;
  const wordCount = countWords(fullText);
  const hasShowTitle = mentionsShowTitle(fullText, showInfo);

  // Full: >1500 chars AND mentions show title AND >300 words
  if (charCount > FULL_TEXT_MIN_CHARS && hasShowTitle && wordCount > FULL_TEXT_MIN_WORDS) {
    return 'full';
  }

  // Partial: 500-1500 chars OR mentions show title but <300 words
  if (charCount >= PARTIAL_MIN_CHARS && charCount <= FULL_TEXT_MIN_CHARS) {
    return 'partial';
  }
  if (hasShowTitle && wordCount < FULL_TEXT_MIN_WORDS && charCount >= PARTIAL_MIN_CHARS) {
    return 'partial';
  }

  // Check if we have enough chars but low word count (might be partial)
  if (charCount > EXCERPT_MAX_CHARS && charCount < FULL_TEXT_MIN_CHARS) {
    return 'partial';
  }

  // Also partial if we have good content but didn't meet full criteria
  if (charCount > FULL_TEXT_MIN_CHARS && (!hasShowTitle || wordCount <= FULL_TEXT_MIN_WORDS)) {
    return 'partial';
  }

  // Excerpt: <500 chars
  if (charCount < EXCERPT_MAX_CHARS) {
    return 'excerpt';
  }

  // Default to partial for anything else with content
  return 'partial';
}

function determineSourceMethod(review) {
  // Check explicit source field first
  if (review.source && SOURCE_METHOD_MAP[review.source]) {
    return SOURCE_METHOD_MAP[review.source];
  }

  // Check textFetchMethod if available
  if (review.textFetchMethod) {
    const method = review.textFetchMethod.toLowerCase();
    if (method.includes('playwright')) return 'playwright';
    if (method.includes('scrapingbee')) return 'scrapingbee';
    if (method.includes('webfetch')) return 'webfetch';
    if (method.includes('archive')) return 'archive';
  }

  // Infer from available excerpts (if no fullText, determine primary source)
  if (!review.fullText || review.fullText.trim().length === 0) {
    if (review.dtliExcerpt && !review.bwwExcerpt && !review.showScoreExcerpt) {
      return 'dtli';
    }
    if (review.showScoreExcerpt && !review.bwwExcerpt && !review.dtliExcerpt) {
      return 'showscore';
    }
    if (review.bwwExcerpt) {
      return 'bww-roundup';
    }
    // If we have any excerpt but can't determine source
    if (review.dtliExcerpt || review.showScoreExcerpt) {
      return 'aggregator';
    }
  }

  // Check if source is in the map
  if (review.source) {
    return SOURCE_METHOD_MAP[review.source] || review.source;
  }

  return 'unknown';
}

function getAllReviewFiles() {
  const files = [];

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(item => {
    const fullPath = path.join(REVIEW_TEXTS_DIR, item);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const reviewFiles = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of reviewFiles) {
      files.push({
        showId: showDir,
        filename: file,
        path: path.join(showPath, file)
      });
    }
  }

  return files;
}

function processReviews(dryRun = false) {
  console.log('Loading show titles...');
  const showTitles = loadShowTitles();

  console.log('Finding all review files...');
  const reviewFiles = getAllReviewFiles();
  console.log(`Found ${reviewFiles.length} review files\n`);

  const stats = {
    total: 0,
    updated: 0,
    byQuality: { full: [], partial: [], excerpt: [], missing: [] },
    byMethod: {},
    errors: []
  };

  for (const fileInfo of reviewFiles) {
    stats.total++;

    try {
      const content = fs.readFileSync(fileInfo.path, 'utf8');
      const review = JSON.parse(content);

      const showInfo = showTitles[fileInfo.showId] || showTitles[review.showId];

      // Classify
      const textQuality = classifyTextQuality(review, showInfo);
      const sourceMethod = determineSourceMethod(review);

      // Track stats
      const relativePath = `${fileInfo.showId}/${fileInfo.filename}`;
      stats.byQuality[textQuality].push(relativePath);
      stats.byMethod[sourceMethod] = (stats.byMethod[sourceMethod] || 0) + 1;

      // Check if update needed
      const needsUpdate = review.textQuality !== textQuality || review.sourceMethod !== sourceMethod;

      if (needsUpdate) {
        review.textQuality = textQuality;
        review.sourceMethod = sourceMethod;

        if (!dryRun) {
          fs.writeFileSync(fileInfo.path, JSON.stringify(review, null, 2) + '\n', 'utf8');
        }
        stats.updated++;
      }

    } catch (error) {
      stats.errors.push({
        file: fileInfo.path,
        error: error.message
      });
    }
  }

  return stats;
}

function generateReport(stats) {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: stats.total,
      full: stats.byQuality.full.length,
      partial: stats.byQuality.partial.length,
      excerpt: stats.byQuality.excerpt.length,
      missing: stats.byQuality.missing.length
    },
    byQuality: {
      full: stats.byQuality.full.sort(),
      partial: stats.byQuality.partial.sort(),
      excerpt: stats.byQuality.excerpt.sort(),
      missing: stats.byQuality.missing.sort()
    },
    byMethod: stats.byMethod,
    targetForLaunch: {
      targetPercent: 80,
      need: Math.ceil(stats.total * 0.8),
      have: stats.byQuality.full.length,
      gap: Math.ceil(stats.total * 0.8) - stats.byQuality.full.length,
      percentComplete: ((stats.byQuality.full.length / stats.total) * 100).toFixed(1) + '%'
    },
    qualityBreakdown: {
      fullPercent: ((stats.byQuality.full.length / stats.total) * 100).toFixed(1) + '%',
      partialPercent: ((stats.byQuality.partial.length / stats.total) * 100).toFixed(1) + '%',
      excerptPercent: ((stats.byQuality.excerpt.length / stats.total) * 100).toFixed(1) + '%',
      missingPercent: ((stats.byQuality.missing.length / stats.total) * 100).toFixed(1) + '%'
    }
  };

  if (stats.errors.length > 0) {
    report.errors = stats.errors;
  }

  return report;
}

function printSummary(report, stats) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    TEXT COVERAGE REPORT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('SUMMARY');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`Total Reviews:     ${report.summary.total}`);
  console.log(`Files Updated:     ${stats.updated}`);
  console.log('');

  console.log('TEXT QUALITY BREAKDOWN');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`Full (>1500 chars, >300 words, has title):  ${report.summary.full.toString().padStart(4)} (${report.qualityBreakdown.fullPercent})`);
  console.log(`Partial (500-1500 chars or incomplete):     ${report.summary.partial.toString().padStart(4)} (${report.qualityBreakdown.partialPercent})`);
  console.log(`Excerpt (<500 chars, aggregator quotes):    ${report.summary.excerpt.toString().padStart(4)} (${report.qualityBreakdown.excerptPercent})`);
  console.log(`Missing (no text):                          ${report.summary.missing.toString().padStart(4)} (${report.qualityBreakdown.missingPercent})`);
  console.log('');

  console.log('SOURCE METHOD BREAKDOWN');
  console.log('───────────────────────────────────────────────────────────────');
  const sortedMethods = Object.entries(report.byMethod).sort((a, b) => b[1] - a[1]);
  for (const [method, count] of sortedMethods) {
    const percent = ((count / report.summary.total) * 100).toFixed(1);
    console.log(`${method.padEnd(20)} ${count.toString().padStart(4)} (${percent}%)`);
  }
  console.log('');

  console.log('TARGET FOR LAUNCH (80% FULL TEXT)');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`Need:              ${report.targetForLaunch.need} reviews with full text`);
  console.log(`Have:              ${report.targetForLaunch.have} reviews with full text`);
  console.log(`Gap:               ${report.targetForLaunch.gap} more needed`);
  console.log(`Progress:          ${report.targetForLaunch.percentComplete}`);
  console.log('');

  // Progress bar
  const percent = parseFloat(report.targetForLaunch.percentComplete);
  const barWidth = 50;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  console.log(`[${bar}] ${report.targetForLaunch.percentComplete}`);
  console.log('');

  if (stats.errors.length > 0) {
    console.log('ERRORS');
    console.log('───────────────────────────────────────────────────────────────');
    for (const err of stats.errors.slice(0, 5)) {
      console.log(`  ${err.file}: ${err.error}`);
    }
    if (stats.errors.length > 5) {
      console.log(`  ... and ${stats.errors.length - 5} more errors`);
    }
    console.log('');
  }

  console.log(`Report saved to: ${REPORT_FILE}`);
}

// Main execution
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (dryRun) {
  console.log('DRY RUN MODE - No files will be modified\n');
}

console.log('Classifying review text quality...\n');
const stats = processReviews(dryRun);

console.log('Generating coverage report...\n');
const report = generateReport(stats);

if (!dryRun) {
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

printSummary(report, stats);
