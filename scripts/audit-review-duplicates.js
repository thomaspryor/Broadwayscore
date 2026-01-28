#!/usr/bin/env node
/**
 * Tasks 1.1 - 1.4: Review Duplicate Detection
 *
 * Detects duplicate reviews using multiple methods:
 * - Task 1.1: Group by showId + normalized outlet + normalized critic
 * - Task 1.1.5: Use OUTLET_ALIASES from review-normalization.js
 * - Task 1.2: URL-based duplicate detection (same URL, different files)
 * - Task 1.2.5: Cross-show URL deduplication (same URL in different show dirs)
 * - Task 1.3: Excerpt sentiment consistency check
 * - Task 1.4: Consolidated duplicate report
 *
 * Output: data/audit/duplicate-review-files.json
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewKey,
  OUTLET_ALIASES
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'duplicate-review-files.json');

// Simple sentiment analysis keywords
const POSITIVE_INDICATORS = [
  'brilliant', 'magnificent', 'stunning', 'exceptional', 'extraordinary',
  'masterpiece', 'triumph', 'joyous', 'wonderful', 'superb', 'phenomenal',
  'breathtaking', 'dazzling', 'sensational', 'riveting', 'thrilling',
  'must-see', 'unmissable', 'outstanding', 'excellent', 'remarkable'
];

const NEGATIVE_INDICATORS = [
  'disappointing', 'fails', 'failure', 'weak', 'boring', 'tedious',
  'dull', 'lifeless', 'lackluster', 'uninspired', 'forgettable',
  'misguided', 'misfire', 'dismal', 'poor', 'terrible', 'awful',
  'painful', 'excruciating', 'waste', 'regrettable'
];

/**
 * Analyze sentiment of an excerpt
 * Returns: 'positive', 'negative', 'mixed', or 'neutral'
 */
function analyzeSentiment(text) {
  if (!text) return 'neutral';

  const lower = text.toLowerCase();
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of POSITIVE_INDICATORS) {
    if (lower.includes(word)) positiveCount++;
  }
  for (const word of NEGATIVE_INDICATORS) {
    if (lower.includes(word)) negativeCount++;
  }

  if (positiveCount > 0 && negativeCount === 0) return 'positive';
  if (negativeCount > 0 && positiveCount === 0) return 'negative';
  if (positiveCount > 0 && negativeCount > 0) return 'mixed';
  return 'neutral';
}

/**
 * Check if two sentiments conflict
 */
function sentimentsConflict(s1, s2) {
  if (s1 === 'neutral' || s2 === 'neutral') return false;
  if (s1 === 'mixed' || s2 === 'mixed') return false;
  return s1 !== s2;
}

function auditReviewDuplicates() {
  console.log('=== Review Duplicate Detection Audit ===\n');

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_files: 0,
      total_shows: 0,
      duplicate_groups: 0,
      cross_show_duplicates: 0,
      url_duplicates_same_show: 0,
      sentiment_inconsistencies: 0
    },
    duplicates: [],
    url_duplicates: [],
    cross_show: [],
    sentiment_issues: []
  };

  // Maps for tracking
  const reviewsByKey = new Map();       // showId|outlet|critic -> [files]
  const urlToFiles = new Map();         // url -> [{showId, file}]
  const allReviews = [];                // All review data for analysis

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  report.summary.total_shows = showDirs.length;
  console.log(`Scanning ${showDirs.length} show directories...\n`);

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filePath = path.join(showPath, file);
      const relativePath = path.join('data/review-texts', showDir, file);

      report.summary.total_files++;

      let data;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        data = JSON.parse(content);
      } catch (e) {
        // Skip invalid JSON (already caught by integrity check)
        continue;
      }

      // Store for analysis
      allReviews.push({
        file: relativePath,
        showId: showDir,
        data
      });

      // Task 1.1 & 1.1.5: Group by normalized outlet + critic
      const normalizedOutlet = normalizeOutlet(data.outlet || data.outletId);
      const normalizedCritic = normalizeCritic(data.criticName);
      const key = `${showDir}|${normalizedOutlet}|${normalizedCritic}`;

      if (!reviewsByKey.has(key)) {
        reviewsByKey.set(key, []);
      }
      reviewsByKey.get(key).push({
        file: relativePath,
        originalOutlet: data.outlet || data.outletId,
        originalCritic: data.criticName,
        normalizedOutlet,
        normalizedCritic
      });

      // Task 1.2 & 1.2.5: Track URLs
      if (data.url && data.url.trim()) {
        // Normalize URL (remove trailing slashes, protocol variations)
        let normalizedUrl = data.url.trim()
          .replace(/\/$/, '')
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '');

        if (!urlToFiles.has(normalizedUrl)) {
          urlToFiles.set(normalizedUrl, []);
        }
        urlToFiles.get(normalizedUrl).push({
          showId: showDir,
          file: relativePath,
          originalUrl: data.url
        });
      }
    }
  }

  // Task 1.1: Find duplicate groups (same show + outlet + critic)
  console.log('Analyzing outlet/critic duplicates...');
  for (const [key, files] of reviewsByKey) {
    if (files.length > 1) {
      const [showId, outlet, critic] = key.split('|');
      report.summary.duplicate_groups++;
      report.duplicates.push({
        showId,
        outlet,
        critic,
        files: files.map(f => f.file),
        reason: 'Same show + outlet + critic (normalized)',
        details: files.map(f => ({
          file: f.file,
          originalOutlet: f.originalOutlet,
          originalCritic: f.originalCritic
        }))
      });
    }
  }

  // Task 1.2: Find URL duplicates within same show
  // Task 1.2.5: Find cross-show URL duplicates
  console.log('Analyzing URL duplicates...');
  for (const [url, entries] of urlToFiles) {
    if (entries.length > 1) {
      const showIds = [...new Set(entries.map(e => e.showId))];

      if (showIds.length > 1) {
        // CRITICAL: Same URL in different shows
        report.summary.cross_show_duplicates++;
        report.cross_show.push({
          url: entries[0].originalUrl,
          shows: showIds,
          files: entries.map(e => e.file),
          severity: 'CRITICAL',
          reason: 'Same URL appears in different show directories'
        });
      } else {
        // Same URL within same show
        report.summary.url_duplicates_same_show++;
        report.url_duplicates.push({
          url: entries[0].originalUrl,
          showId: showIds[0],
          files: entries.map(e => e.file),
          reason: 'Same URL in multiple files for same show'
        });
      }
    }
  }

  // Task 1.3: Check excerpt sentiment consistency
  console.log('Analyzing excerpt sentiment consistency...');
  for (const review of allReviews) {
    const excerpts = [];
    if (review.data.dtliExcerpt) excerpts.push({ source: 'dtli', text: review.data.dtliExcerpt });
    if (review.data.bwwExcerpt) excerpts.push({ source: 'bww', text: review.data.bwwExcerpt });
    if (review.data.showScoreExcerpt) excerpts.push({ source: 'showScore', text: review.data.showScoreExcerpt });

    if (excerpts.length >= 2) {
      // Analyze sentiment of each excerpt
      const sentiments = excerpts.map(e => ({
        ...e,
        sentiment: analyzeSentiment(e.text)
      }));

      // Check for conflicts
      for (let i = 0; i < sentiments.length; i++) {
        for (let j = i + 1; j < sentiments.length; j++) {
          if (sentimentsConflict(sentiments[i].sentiment, sentiments[j].sentiment)) {
            report.summary.sentiment_inconsistencies++;
            report.sentiment_issues.push({
              file: review.file,
              showId: review.showId,
              outlet: review.data.outlet || review.data.outletId,
              critic: review.data.criticName,
              conflicting_excerpts: [
                {
                  source: sentiments[i].source,
                  sentiment: sentiments[i].sentiment,
                  excerpt: sentiments[i].text.substring(0, 100) + '...'
                },
                {
                  source: sentiments[j].source,
                  sentiment: sentiments[j].sentiment,
                  excerpt: sentiments[j].text.substring(0, 100) + '...'
                }
              ],
              reason: 'Excerpts from different sources have conflicting sentiment'
            });
            break; // Only flag once per file
          }
        }
      }
    }
  }

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Total files scanned: ${report.summary.total_files}`);
  console.log(`Total shows: ${report.summary.total_shows}`);
  console.log(`\nDuplicate Detection Results:`);
  console.log(`  Outlet/critic duplicate groups: ${report.summary.duplicate_groups}`);
  console.log(`  URL duplicates (same show): ${report.summary.url_duplicates_same_show}`);
  console.log(`  Cross-show URL duplicates: ${report.summary.cross_show_duplicates} ${report.summary.cross_show_duplicates > 0 ? '*** CRITICAL ***' : '(PASS)'}`);
  console.log(`  Sentiment inconsistencies: ${report.summary.sentiment_inconsistencies}`);

  // Show some examples
  if (report.duplicates.length > 0) {
    console.log('\n--- Sample Outlet/Critic Duplicates ---');
    for (const dup of report.duplicates.slice(0, 5)) {
      console.log(`  ${dup.showId}: ${dup.outlet} / ${dup.critic}`);
      for (const detail of dup.details) {
        console.log(`    - ${detail.file}`);
        console.log(`      Original: ${detail.originalOutlet} / ${detail.originalCritic}`);
      }
    }
    if (report.duplicates.length > 5) {
      console.log(`  ... and ${report.duplicates.length - 5} more duplicate groups`);
    }
  }

  if (report.cross_show.length > 0) {
    console.log('\n*** CRITICAL: Cross-Show URL Duplicates ***');
    for (const dup of report.cross_show) {
      console.log(`  URL: ${dup.url}`);
      console.log(`  Shows: ${dup.shows.join(', ')}`);
      console.log(`  Files: ${dup.files.join(', ')}`);
    }
  }

  if (report.sentiment_issues.length > 0) {
    console.log('\n--- Sample Sentiment Inconsistencies ---');
    for (const issue of report.sentiment_issues.slice(0, 3)) {
      console.log(`  ${issue.file}`);
      console.log(`    ${issue.conflicting_excerpts[0].source}: ${issue.conflicting_excerpts[0].sentiment}`);
      console.log(`    ${issue.conflicting_excerpts[1].source}: ${issue.conflicting_excerpts[1].sentiment}`);
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write report
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${OUTPUT_PATH}`);

  // Validation results
  const passed =
    report.summary.cross_show_duplicates === 0 &&
    report.summary.duplicate_groups < 50;

  if (passed) {
    console.log('\nPASSED: Duplicate audit within acceptable thresholds');
  } else {
    console.log('\nFAILED: Duplicate audit thresholds exceeded');
    if (report.summary.cross_show_duplicates > 0) {
      console.log('  - Cross-show duplicates must be 0');
    }
    if (report.summary.duplicate_groups >= 50) {
      console.log('  - Duplicate groups must be < 50');
    }
  }

  return passed;
}

// Run if called directly
if (require.main === module) {
  const success = auditReviewDuplicates();
  process.exit(success ? 0 : 1);
}

module.exports = { auditReviewDuplicates };
