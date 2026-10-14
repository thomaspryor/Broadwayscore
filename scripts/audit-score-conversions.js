#!/usr/bin/env node
/**
 * Score Conversion Audit Script
 *
 * Sprint 3 of Data Quality Audit Plan
 *
 * Audits all reviews to verify that assignedScore correctly reflects originalRating.
 * Generates a comprehensive report of:
 * - Correctly calculated scores
 * - Miscalculated scores (difference > tolerance)
 * - Unparseable ratings
 * - AI-scored reviews (have assignedScore but no originalRating)
 *
 * Usage: node scripts/audit-score-conversions.js [--tolerance=10] [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { validateScore, parseRating } = require('./lib/score-conversion-rules');

// Configuration
const TOLERANCE = parseInt(process.argv.find(a => a.startsWith('--tolerance='))?.split('=')[1] || '10');
const VERBOSE = process.argv.includes('--verbose');

// Paths
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'audit');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'score-conversion-audit.json');

function log(msg) {
  console.log(msg);
}

function verbose(msg) {
  if (VERBOSE) console.log(msg);
}

/**
 * Check if a review has full text (for AI-scored review validation)
 */
function hasFullText(showId, outletId, criticName) {
  // Normalize to find the file
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return false;

  // Try to find the review file
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));
      // Check if this is the right review
      if (data.outletId === outletId ||
          data.outlet?.toLowerCase().includes(outletId.toLowerCase()) ||
          file.startsWith(outletId.toLowerCase())) {
        if (data.criticName === criticName ||
            file.includes(criticName?.toLowerCase().replace(/\s+/g, '-'))) {
          return !!(data.fullText && data.fullText.length > 100);
        }
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return null; // Unknown (couldn't find file)
}

/**
 * Check the review-texts file to see how the score was derived
 */
function getScoreSource(showId, outletId, criticName) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));
      // Check if this is the right review
      if (data.outletId === outletId ||
          data.outlet?.toLowerCase().includes(outletId.toLowerCase()) ||
          file.startsWith(outletId.toLowerCase())) {
        if (data.criticName === criticName ||
            file.includes(criticName?.toLowerCase().replace(/\s+/g, '-'))) {
          return {
            source: data.source || data.scoreSource || 'unknown',
            hasLlmScore: !!data.llmScore,
            hasFullText: !!(data.fullText && data.fullText.length > 100),
            file: file
          };
        }
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return null;
}

/**
 * Main audit function
 */
async function runAudit() {
  log('=== SCORE CONVERSION AUDIT (Sprint 3) ===\n');
  log(`Tolerance: ${TOLERANCE} points\n`);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load reviews
  log('Loading reviews...');
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf-8'));
  const reviews = reviewsData.reviews;
  log(`Loaded ${reviews.length} reviews\n`);

  // Categorize reviews
  const results = {
    correct: [],
    miscalculated: [],
    unparseable: [],
    nullRating: [],
    designationOnly: [],
    aiScored: []
  };

  // Process each review
  for (const review of reviews) {
    const hasOriginalRating = review.originalRating !== null && review.originalRating !== undefined;
    const hasAssignedScore = review.assignedScore !== null && review.assignedScore !== undefined;

    // Case 1: Has originalRating and assignedScore - validate conversion
    if (hasOriginalRating && hasAssignedScore) {
      const validation = validateScore(review.originalRating, review.assignedScore, TOLERANCE);

      if (validation.skipped && validation.reason === 'designation_only') {
        results.designationOnly.push({
          showId: review.showId,
          outlet: review.outlet,
          criticName: review.criticName,
          originalRating: review.originalRating,
          assignedScore: review.assignedScore
        });
      } else if (validation.reason === 'unparseable') {
        results.unparseable.push({
          showId: review.showId,
          outlet: review.outlet,
          criticName: review.criticName,
          originalRating: review.originalRating,
          assignedScore: review.assignedScore,
          parseAttempt: validation.parseResult
        });
      } else if (validation.valid) {
        results.correct.push({
          showId: review.showId,
          outlet: review.outlet,
          criticName: review.criticName,
          originalRating: review.originalRating,
          assignedScore: review.assignedScore,
          expectedScore: validation.expected,
          difference: validation.difference
        });
      } else {
        // Check if this might be LLM-scored (intentional discrepancy)
        const scoreSourceInfo = getScoreSource(review.showId, review.outlet, review.criticName);

        results.miscalculated.push({
          showId: review.showId,
          outlet: review.outlet,
          criticName: review.criticName,
          originalRating: review.originalRating,
          assignedScore: review.assignedScore,
          expectedScore: validation.expected,
          difference: validation.difference,
          parseResult: validation.parseResult,
          // Additional context for analysis
          likelyLlmScored: scoreSourceInfo?.hasLlmScore || scoreSourceInfo?.hasFullText || false,
          scoreSourceInfo
        });
      }
    }
    // Case 2: No originalRating - check if it's AI-scored or just missing
    else if (!hasOriginalRating && hasAssignedScore) {
      results.nullRating.push({
        showId: review.showId,
        outlet: review.outlet,
        criticName: review.criticName,
        assignedScore: review.assignedScore
      });
    }
  }

  // AI-scored review audit (Task 3.5.5)
  log('\nAuditing AI-scored reviews...');
  let aiScoredWithText = 0;
  let aiScoredWithoutText = 0;
  let aiScoredUnknown = 0;

  // Sample check for AI-scored reviews (checking all would be too slow)
  const sampleSize = Math.min(100, results.nullRating.length);
  const sampledNullRatings = results.nullRating.slice(0, sampleSize);

  for (const review of sampledNullRatings) {
    const hasText = hasFullText(review.showId, review.outlet, review.criticName);
    if (hasText === true) {
      aiScoredWithText++;
    } else if (hasText === false) {
      aiScoredWithoutText++;
      results.aiScored.push({
        ...review,
        hasFullText: false,
        flagged: true,
        reason: 'AI-scored review without full text'
      });
    } else {
      aiScoredUnknown++;
    }
  }

  // Calculate statistics
  const totalWithBoth = results.correct.length + results.miscalculated.length + results.unparseable.length + results.designationOnly.length;
  const totalScorable = results.correct.length + results.miscalculated.length;
  const miscalculationRate = totalScorable > 0 ? (results.miscalculated.length / totalScorable * 100).toFixed(2) : 0;
  const unparseableRate = totalWithBoth > 0 ? (results.unparseable.length / totalWithBoth * 100).toFixed(2) : 0;

  // Analyze miscalculations - are they LLM-scored intentional discrepancies or actual errors?
  const llmScoredMiscalculations = results.miscalculated.filter(r => r.likelyLlmScored);
  const trueErrorMiscalculations = results.miscalculated.filter(r => !r.likelyLlmScored);
  const trueErrorRate = totalScorable > 0 ? (trueErrorMiscalculations.length / totalScorable * 100).toFixed(2) : 0;

  // Generate report
  const report = {
    _meta: {
      generatedAt: new Date().toISOString(),
      tolerance: TOLERANCE,
      reviewsFile: 'data/reviews.json',
      notes: 'LLM-scored reviews intentionally use full text analysis instead of originalRating conversion'
    },
    summary: {
      total_reviews: reviews.length,
      with_original_rating: totalWithBoth,
      without_original_rating: results.nullRating.length,
      total_scorable: totalScorable,
      correct: results.correct.length,
      miscalculated: results.miscalculated.length,
      unparseable: results.unparseable.length,
      designation_only: results.designationOnly.length,
      miscalculation_rate: `${miscalculationRate}%`,
      unparseable_rate: `${unparseableRate}%`,
      // Breakdown of miscalculations
      miscalculation_breakdown: {
        total: results.miscalculated.length,
        llm_scored_intentional: llmScoredMiscalculations.length,
        true_errors: trueErrorMiscalculations.length,
        true_error_rate: `${trueErrorRate}%`
      },
      ai_scored: {
        total: results.nullRating.length,
        sampled: sampleSize,
        with_full_text: aiScoredWithText,
        without_full_text: aiScoredWithoutText,
        unknown: aiScoredUnknown
      }
    },
    validation: {
      // Consider LLM-scored discrepancies as acceptable (they're intentional)
      // True error rate is what matters for quality
      miscalculation_rate_pass: parseFloat(miscalculationRate) < 5,
      true_error_rate_pass: parseFloat(trueErrorRate) < 5,
      unparseable_rate_pass: parseFloat(unparseableRate) < 10,
      overall_pass: parseFloat(trueErrorRate) < 5 && parseFloat(unparseableRate) < 10
    },
    miscalculated: results.miscalculated.sort((a, b) => b.difference - a.difference),
    true_errors: trueErrorMiscalculations.sort((a, b) => b.difference - a.difference),
    unparseable: results.unparseable,
    designation_only: results.designationOnly,
    ai_scored_flagged: results.aiScored,
    correct_sample: results.correct.slice(0, 10) // Sample of correct conversions
  };

  // Save report
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  log(`\nReport saved to: ${OUTPUT_PATH}`);

  // Print summary
  log('\n=== SUMMARY ===');
  log(`Total reviews: ${reviews.length}`);
  log(`With original rating: ${totalWithBoth}`);
  log(`Without original rating (AI-scored): ${results.nullRating.length}`);
  log(`\nOf reviews with original ratings:`);
  log(`  - Correctly calculated: ${results.correct.length}`);
  log(`  - Miscalculated: ${results.miscalculated.length}`);
  log(`    - LLM-scored (intentional): ${llmScoredMiscalculations.length}`);
  log(`    - True errors: ${trueErrorMiscalculations.length}`);
  log(`  - Unparseable: ${results.unparseable.length}`);
  log(`  - Designation-only: ${results.designationOnly.length}`);
  log(`\nRaw miscalculation rate: ${miscalculationRate}%`);
  log(`True error rate: ${trueErrorRate}% (target: <5%)`);
  log(`Unparseable rate: ${unparseableRate}% (target: <10%)`);

  // Validation status
  log('\n=== VALIDATION ===');
  if (report.validation.true_error_rate_pass) {
    log('✓ True error rate PASS');
  } else {
    log('✗ True error rate FAIL');
  }
  if (report.validation.unparseable_rate_pass) {
    log('✓ Unparseable rate PASS');
  } else {
    log('✗ Unparseable rate FAIL');
  }
  if (report.validation.overall_pass) {
    log('\n✓ OVERALL: PASS');
  } else {
    log('\n✗ OVERALL: FAIL - Review miscalculated items');
  }

  // Show miscalculated reviews if any
  if (results.miscalculated.length > 0) {
    log('\n=== MISCALCULATED REVIEWS ===');
    // Task 3.5: Spot-check logic
    let itemsToShow;
    if (results.miscalculated.length < 20) {
      itemsToShow = results.miscalculated;
      log('(Showing ALL miscalculated reviews)');
    } else if (results.miscalculated.length <= 100) {
      // Random 10%
      const sampleCount = Math.ceil(results.miscalculated.length * 0.1);
      itemsToShow = results.miscalculated
        .sort(() => Math.random() - 0.5)
        .slice(0, sampleCount);
      log(`(Showing random 10%: ${sampleCount} of ${results.miscalculated.length})`);
    } else {
      // Prioritize by score difference (top 20)
      itemsToShow = results.miscalculated.slice(0, 20);
      log(`(Showing top 20 by score difference)`);
    }

    for (const item of itemsToShow) {
      log(`\n  ${item.showId} | ${item.outlet} | ${item.criticName}`);
      log(`    Original: ${JSON.stringify(item.originalRating)}`);
      log(`    Assigned: ${item.assignedScore}, Expected: ${item.expectedScore}`);
      log(`    Difference: ${item.difference} points`);
    }
  }

  // Show unparseable if any
  if (results.unparseable.length > 0 && VERBOSE) {
    log('\n=== UNPARSEABLE RATINGS ===');
    for (const item of results.unparseable) {
      log(`  ${item.showId} | ${item.outlet}: "${item.originalRating}"`);
    }
  }

  // AI-scored summary
  log('\n=== AI-SCORED REVIEWS ===');
  log(`Total without originalRating: ${results.nullRating.length}`);
  log(`Sampled: ${sampleSize}`);
  log(`  - With full text: ${aiScoredWithText}`);
  log(`  - Without full text: ${aiScoredWithoutText} (flagged)`);
  log(`  - Unknown: ${aiScoredUnknown}`);

  return report;
}

// Run
runAudit().catch(err => {
  console.error('Error running audit:', err);
  process.exit(1);
});
