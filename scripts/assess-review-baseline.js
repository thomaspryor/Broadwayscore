#!/usr/bin/env node

/**
 * Sprint 1: Baseline Assessment Script
 *
 * Analyzes the review data to create a baseline assessment:
 * 1. Counts all review files per show
 * 2. Identifies shows with few (<5) or many (>40) reviews
 * 3. Finds file naming issues (missing critic or outlet)
 * 4. Detects potential duplicates within each show
 *
 * Output: data/audit/baseline-assessment.json
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic, areCriticsSimilar, levenshteinDistance } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const OUTPUT_DIR = path.join(__dirname, '../data/audit');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'baseline-assessment.json');

function getShowDirectories() {
  return fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    })
    .sort();
}

function getReviewFiles(showDir) {
  const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
  return fs.readdirSync(showPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
    .sort();
}

function parseFilename(filename) {
  // Expected format: {outlet}--{critic}.json
  const match = filename.match(/^(.+?)--(.+?)\.json$/);
  if (!match) {
    return { outlet: null, critic: null, valid: false };
  }
  return {
    outlet: match[1],
    critic: match[2],
    valid: true
  };
}

function analyzeShow(showDir) {
  const files = getReviewFiles(showDir);
  const analysis = {
    showId: showDir,
    totalFiles: files.length,
    namingIssues: [],
    potentialDuplicates: []
  };

  const reviewsByOutlet = {};
  const normalizedKeys = {};

  for (const file of files) {
    const { outlet, critic, valid } = parseFilename(file);

    // Check for naming issues
    if (!valid) {
      analysis.namingIssues.push({
        file,
        issue: 'Invalid filename format (no -- separator)'
      });
      continue;
    }

    if (!outlet || outlet === '') {
      analysis.namingIssues.push({
        file,
        issue: 'Missing outlet name'
      });
    }

    if (!critic || critic === '' || critic === 'unknown') {
      analysis.namingIssues.push({
        file,
        issue: `Missing or unknown critic name: "${critic}"`
      });
    }

    if (outlet === 'unknown') {
      analysis.namingIssues.push({
        file,
        issue: 'Unknown outlet'
      });
    }

    // Group by outlet for duplicate detection
    const normalizedOutlet = normalizeOutlet(outlet);
    if (!reviewsByOutlet[normalizedOutlet]) {
      reviewsByOutlet[normalizedOutlet] = [];
    }
    reviewsByOutlet[normalizedOutlet].push({ file, outlet, critic });

    // Track normalized keys for exact duplicate detection
    const normalizedCritic = normalizeCritic(critic);
    const key = `${normalizedOutlet}|${normalizedCritic}`;
    if (!normalizedKeys[key]) {
      normalizedKeys[key] = [];
    }
    normalizedKeys[key].push(file);
  }

  // Find exact duplicates (same normalized key)
  for (const [key, fileList] of Object.entries(normalizedKeys)) {
    if (fileList.length > 1) {
      analysis.potentialDuplicates.push({
        type: 'exact-normalized',
        reason: `Same normalized key: ${key}`,
        files: fileList
      });
    }
  }

  // Find similar critic names within same outlet
  for (const [outlet, reviews] of Object.entries(reviewsByOutlet)) {
    if (reviews.length < 2) continue;

    for (let i = 0; i < reviews.length; i++) {
      for (let j = i + 1; j < reviews.length; j++) {
        const r1 = reviews[i];
        const r2 = reviews[j];

        // Skip if already caught as exact duplicate
        const key1 = `${outlet}|${normalizeCritic(r1.critic)}`;
        const key2 = `${outlet}|${normalizeCritic(r2.critic)}`;
        if (key1 === key2) continue;

        // Check for similar critic names
        if (areCriticsSimilar(r1.critic, r2.critic)) {
          // Make sure we don't duplicate entries
          const existingDup = analysis.potentialDuplicates.find(
            d => d.files.includes(r1.file) && d.files.includes(r2.file)
          );
          if (!existingDup) {
            analysis.potentialDuplicates.push({
              type: 'similar-critic',
              reason: `Similar critic names: "${r1.critic}" vs "${r2.critic}"`,
              files: [r1.file, r2.file]
            });
          }
        }

        // Check for partial name match (e.g., "christian" vs "christian-holub")
        const c1 = r1.critic.toLowerCase();
        const c2 = r2.critic.toLowerCase();
        if (c1 !== c2 && (c2.startsWith(c1 + '-') || c1.startsWith(c2 + '-'))) {
          const existingDup = analysis.potentialDuplicates.find(
            d => d.files.includes(r1.file) && d.files.includes(r2.file)
          );
          if (!existingDup) {
            analysis.potentialDuplicates.push({
              type: 'partial-name',
              reason: `Partial name match: "${r1.critic}" vs "${r2.critic}"`,
              files: [r1.file, r2.file]
            });
          }
        }
      }
    }
  }

  return analysis;
}

function main() {
  console.log('Starting baseline assessment of review data...\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const shows = getShowDirectories();
  console.log(`Found ${shows.length} shows with review data\n`);

  const assessment = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalShows: shows.length,
      totalReviewFiles: 0,
      showsWithFewReviews: [],      // <5 reviews
      showsWithManyReviews: [],     // >40 reviews
      showsWithNamingIssues: [],
      showsWithDuplicates: [],
      totalNamingIssues: 0,
      totalPotentialDuplicates: 0
    },
    showDetails: {}
  };

  // Analyze each show
  for (const showDir of shows) {
    const analysis = analyzeShow(showDir);
    assessment.showDetails[showDir] = analysis;
    assessment.summary.totalReviewFiles += analysis.totalFiles;

    // Categorize by review count
    if (analysis.totalFiles < 5) {
      assessment.summary.showsWithFewReviews.push({
        showId: showDir,
        count: analysis.totalFiles
      });
    }
    if (analysis.totalFiles > 40) {
      assessment.summary.showsWithManyReviews.push({
        showId: showDir,
        count: analysis.totalFiles
      });
    }

    // Track issues
    if (analysis.namingIssues.length > 0) {
      assessment.summary.showsWithNamingIssues.push(showDir);
      assessment.summary.totalNamingIssues += analysis.namingIssues.length;
    }

    if (analysis.potentialDuplicates.length > 0) {
      assessment.summary.showsWithDuplicates.push(showDir);
      assessment.summary.totalPotentialDuplicates += analysis.potentialDuplicates.length;
    }
  }

  // Sort by count
  assessment.summary.showsWithFewReviews.sort((a, b) => a.count - b.count);
  assessment.summary.showsWithManyReviews.sort((a, b) => b.count - a.count);

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(assessment, null, 2));
  console.log(`Assessment saved to: ${OUTPUT_FILE}\n`);

  // Print summary
  console.log('=== BASELINE ASSESSMENT SUMMARY ===\n');
  console.log(`Total shows: ${assessment.summary.totalShows}`);
  console.log(`Total review files: ${assessment.summary.totalReviewFiles}`);
  console.log(`Average reviews per show: ${(assessment.summary.totalReviewFiles / assessment.summary.totalShows).toFixed(1)}\n`);

  console.log(`Shows with few reviews (<5): ${assessment.summary.showsWithFewReviews.length}`);
  if (assessment.summary.showsWithFewReviews.length > 0) {
    for (const s of assessment.summary.showsWithFewReviews) {
      console.log(`  - ${s.showId}: ${s.count} reviews`);
    }
  }

  console.log(`\nShows with many reviews (>40): ${assessment.summary.showsWithManyReviews.length}`);
  if (assessment.summary.showsWithManyReviews.length > 0) {
    for (const s of assessment.summary.showsWithManyReviews.slice(0, 10)) {
      console.log(`  - ${s.showId}: ${s.count} reviews`);
    }
    if (assessment.summary.showsWithManyReviews.length > 10) {
      console.log(`  ... and ${assessment.summary.showsWithManyReviews.length - 10} more`);
    }
  }

  console.log(`\nShows with naming issues: ${assessment.summary.showsWithNamingIssues.length}`);
  console.log(`Total naming issues: ${assessment.summary.totalNamingIssues}`);
  if (assessment.summary.showsWithNamingIssues.length > 0) {
    console.log('Shows affected:');
    for (const showId of assessment.summary.showsWithNamingIssues.slice(0, 10)) {
      const issues = assessment.showDetails[showId].namingIssues;
      console.log(`  - ${showId}: ${issues.length} issues`);
      for (const issue of issues.slice(0, 3)) {
        console.log(`      ${issue.file}: ${issue.issue}`);
      }
      if (issues.length > 3) {
        console.log(`      ... and ${issues.length - 3} more`);
      }
    }
  }

  console.log(`\nShows with potential duplicates: ${assessment.summary.showsWithDuplicates.length}`);
  console.log(`Total potential duplicate groups: ${assessment.summary.totalPotentialDuplicates}`);
  if (assessment.summary.showsWithDuplicates.length > 0) {
    console.log('Shows affected:');
    for (const showId of assessment.summary.showsWithDuplicates.slice(0, 10)) {
      const dups = assessment.showDetails[showId].potentialDuplicates;
      console.log(`  - ${showId}: ${dups.length} duplicate groups`);
      for (const dup of dups.slice(0, 3)) {
        console.log(`      [${dup.type}] ${dup.reason}`);
        console.log(`        Files: ${dup.files.join(', ')}`);
      }
      if (dups.length > 3) {
        console.log(`      ... and ${dups.length - 3} more`);
      }
    }
  }

  console.log('\n=== END SUMMARY ===');
}

main();
