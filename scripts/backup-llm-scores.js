#!/usr/bin/env node

/**
 * Sprint 2.1: Backup LLM Scores Script
 *
 * Extracts and backs up all existing LLM scores from review files before
 * any cleanup operations. This ensures no scoring data is lost during
 * duplicate merging.
 *
 * Backs up:
 * - llmScore (score, bucket, confidence, range, components, etc.)
 * - llmMetadata (model, scoredAt, promptVersion)
 * - ensembleData (claudeScore, openaiScore, etc.)
 *
 * Output: data/audit/llm-scores-backup.json
 */

const fs = require('fs');
const path = require('path');
const { normalizeCritic, normalizeOutlet } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const OUTPUT_DIR = path.join(__dirname, '../data/audit');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'llm-scores-backup.json');

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
  const match = filename.match(/^(.+?)--(.+?)\.json$/);
  if (!match) {
    return { outlet: null, critic: null };
  }
  return { outlet: match[1], critic: match[2] };
}

function main() {
  console.log('Backing up LLM scores from review data...\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const shows = getShowDirectories();
  console.log(`Found ${shows.length} shows with review data\n`);

  const backup = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalReviews: 0,
      reviewsWithLlmScore: 0,
      reviewsWithEnsembleData: 0,
      reviewsWithAssignedScore: 0,
      showsProcessed: shows.length
    },
    scores: {}
  };

  let processedReviews = 0;
  let scoredReviews = 0;

  for (const showDir of shows) {
    const files = getReviewFiles(showDir);

    for (const file of files) {
      const filePath = path.join(REVIEW_TEXTS_DIR, showDir, file);
      let review;

      try {
        review = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        console.error(`Error reading ${filePath}: ${err.message}`);
        continue;
      }

      processedReviews++;

      // Extract outlet and critic from filename
      const { outlet, critic } = parseFilename(file);
      const normalizedOutlet = normalizeOutlet(outlet || review.outletId || 'unknown');
      const normalizedCritic = normalizeCritic(critic || review.criticName || 'unknown');

      // Create unique key: showId|outletId|criticSlug
      const key = `${showDir}|${normalizedOutlet}|${normalizedCritic}`;

      // Check if there's any score data to backup
      const hasLlmScore = review.llmScore && (review.llmScore.score !== null || review.llmScore.bucket);
      const hasEnsembleData = review.ensembleData && (review.ensembleData.claudeScore !== null || review.ensembleData.openaiScore !== null);
      const hasAssignedScore = review.assignedScore !== null && review.assignedScore !== undefined;

      if (hasLlmScore || hasEnsembleData || hasAssignedScore) {
        scoredReviews++;

        const scoreData = {
          sourceFile: `${showDir}/${file}`,
          showId: showDir,
          outletId: normalizedOutlet,
          criticSlug: normalizedCritic,
          criticName: review.criticName,
          outlet: review.outlet
        };

        // Backup assignedScore
        if (hasAssignedScore) {
          scoreData.assignedScore = review.assignedScore;
          backup.summary.reviewsWithAssignedScore++;
        }

        // Backup llmScore
        if (hasLlmScore) {
          scoreData.llmScore = review.llmScore;
          backup.summary.reviewsWithLlmScore++;
        }

        // Backup llmMetadata
        if (review.llmMetadata) {
          scoreData.llmMetadata = review.llmMetadata;
        }

        // Backup ensembleData
        if (hasEnsembleData) {
          scoreData.ensembleData = review.ensembleData;
          backup.summary.reviewsWithEnsembleData++;
        }

        // Backup other score-related fields
        if (review.scoreSource) scoreData.scoreSource = review.scoreSource;
        if (review.scoreConfidence) scoreData.scoreConfidence = review.scoreConfidence;
        if (review.extractedPhrase) scoreData.extractedPhrase = review.extractedPhrase;
        if (review.originalScore !== null && review.originalScore !== undefined) {
          scoreData.originalScore = review.originalScore;
        }
        if (review.originalRating) scoreData.originalRating = review.originalRating;

        backup.scores[key] = scoreData;
      }
    }
  }

  backup.summary.totalReviews = processedReviews;

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(backup, null, 2));
  console.log(`Backup saved to: ${OUTPUT_FILE}\n`);

  // Print summary
  console.log('=== LLM SCORES BACKUP SUMMARY ===\n');
  console.log(`Total reviews processed: ${processedReviews}`);
  console.log(`Reviews with any score data: ${scoredReviews}`);
  console.log(`Reviews with LLM scores: ${backup.summary.reviewsWithLlmScore}`);
  console.log(`Reviews with ensemble data: ${backup.summary.reviewsWithEnsembleData}`);
  console.log(`Reviews with assigned scores: ${backup.summary.reviewsWithAssignedScore}`);
  console.log(`\nBackup entries saved: ${Object.keys(backup.scores).length}`);

  // Show sample entries
  const sampleKeys = Object.keys(backup.scores).slice(0, 3);
  if (sampleKeys.length > 0) {
    console.log('\nSample backup entries:');
    for (const key of sampleKeys) {
      const data = backup.scores[key];
      console.log(`  ${key}`);
      if (data.llmScore) {
        console.log(`    LLM Score: ${data.llmScore.score} (${data.llmScore.bucket}, ${data.llmScore.confidence})`);
      }
      if (data.assignedScore !== undefined) {
        console.log(`    Assigned Score: ${data.assignedScore}`);
      }
    }
  }

  console.log('\n=== END SUMMARY ===');
}

main();
