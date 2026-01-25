#!/usr/bin/env node
/**
 * Score Validation Script
 * Compares assignedScore against dtliThumb, bwwThumb, and originalRating
 * Outputs misalignments and validation report
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit', 'reports');

// Validation thresholds (from user requirements)
const THUMB_SCORE_THRESHOLDS = {
  Up: { min: 55, name: 'thumbs up should be >= 55' },
  Down: { max: 65, name: 'thumbs down should be <= 65' },
  Meh: { min: 45, max: 75, name: 'meh should be 45-75' },
};

// Letter grade expected ranges
const LETTER_GRADE_RANGES = {
  'A+': { min: 90, max: 100 },
  'A': { min: 85, max: 100 },
  'A-': { min: 80, max: 95 },
  'B+': { min: 75, max: 90 },
  'B': { min: 70, max: 85 },
  'B-': { min: 65, max: 80 },
  'C+': { min: 60, max: 75 },
  'C': { min: 55, max: 70 },
  'C-': { min: 50, max: 65 },
  'D+': { min: 45, max: 60 },
  'D': { min: 40, max: 55 },
  'D-': { min: 35, max: 50 },
  'F': { min: 0, max: 45 },
};

// Star rating expected ranges (based on scale)
function getStarRange(stars, maxStars) {
  const ratio = stars / maxStars;
  if (ratio >= 0.9) return { min: 85, max: 100 };
  if (ratio >= 0.8) return { min: 75, max: 90 };
  if (ratio >= 0.7) return { min: 65, max: 80 };
  if (ratio >= 0.6) return { min: 55, max: 70 };
  if (ratio >= 0.5) return { min: 45, max: 60 };
  if (ratio >= 0.4) return { min: 35, max: 50 };
  return { min: 0, max: 45 };
}

// Parse original rating to expected range
function parseOriginalRating(rating) {
  if (!rating || rating === 'null') return null;

  const str = String(rating).trim().toUpperCase();

  // Letter grades
  if (LETTER_GRADE_RANGES[str]) {
    return { type: 'letter', value: str, range: LETTER_GRADE_RANGES[str] };
  }

  // Star ratings: "4/5", "3.5/5", "4 out of 5", etc.
  const starMatch = str.match(/(\d+\.?\d*)\s*(?:\/|OUT OF|OF)\s*(\d+)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = parseInt(starMatch[2]);
    return { type: 'stars', value: `${stars}/${maxStars}`, range: getStarRange(stars, maxStars) };
  }

  // Standalone stars: "4 stars", "3.5 stars"
  const standAloneMatch = str.match(/(\d+\.?\d*)\s*STAR/i);
  if (standAloneMatch) {
    const stars = parseFloat(standAloneMatch[1]);
    // Assume 5-star scale
    return { type: 'stars', value: `${stars}/5`, range: getStarRange(stars, 5) };
  }

  // Sentiment buckets
  const sentimentMap = {
    'RAVE': { min: 85, max: 100 },
    'POSITIVE': { min: 72, max: 90 },
    'MIXED-POSITIVE': { min: 62, max: 78 },
    'MIXED': { min: 55, max: 70 },
    'MIXED-NEGATIVE': { min: 45, max: 62 },
    'NEGATIVE': { min: 35, max: 55 },
    'PAN': { min: 0, max: 40 },
  };

  if (sentimentMap[str]) {
    return { type: 'sentiment', value: str, range: sentimentMap[str] };
  }

  return null;
}

function getAllReviewFiles() {
  const files = [];
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR);

  for (const showDir of shows) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    if (!fs.statSync(showPath).isDirectory()) continue;

    const reviewFiles = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
    for (const file of reviewFiles) {
      files.push(path.join(showPath, file));
    }
  }

  return files;
}

function validateReview(filePath, review) {
  const flags = [];
  const { assignedScore, dtliThumb, bwwThumb, originalScore, originalRating, outlet, criticName, showId } = review;

  if (assignedScore === null || assignedScore === undefined) {
    return { flags: [{ type: 'missing_score', message: 'No assignedScore' }], severity: 'info' };
  }

  // Validate against DTLI thumb
  if (dtliThumb) {
    const threshold = THUMB_SCORE_THRESHOLDS[dtliThumb];
    if (threshold) {
      if (dtliThumb === 'Up' && assignedScore < threshold.min) {
        flags.push({
          type: 'dtli_mismatch',
          severity: 'high',
          message: `DTLI "Up" but score ${assignedScore} < ${threshold.min}`,
          expected: `>= ${threshold.min}`,
          actual: assignedScore,
        });
      }
      if (dtliThumb === 'Down' && assignedScore > threshold.max) {
        flags.push({
          type: 'dtli_mismatch',
          severity: 'high',
          message: `DTLI "Down" but score ${assignedScore} > ${threshold.max}`,
          expected: `<= ${threshold.max}`,
          actual: assignedScore,
        });
      }
      if (dtliThumb === 'Meh' && (assignedScore < threshold.min || assignedScore > threshold.max)) {
        flags.push({
          type: 'dtli_mismatch',
          severity: 'medium',
          message: `DTLI "Meh" but score ${assignedScore} outside ${threshold.min}-${threshold.max}`,
          expected: `${threshold.min}-${threshold.max}`,
          actual: assignedScore,
        });
      }
    }
  }

  // Validate against BWW thumb
  if (bwwThumb) {
    const threshold = THUMB_SCORE_THRESHOLDS[bwwThumb];
    if (threshold) {
      if (bwwThumb === 'Up' && assignedScore < threshold.min) {
        flags.push({
          type: 'bww_mismatch',
          severity: 'high',
          message: `BWW "Up" but score ${assignedScore} < ${threshold.min}`,
          expected: `>= ${threshold.min}`,
          actual: assignedScore,
        });
      }
      if (bwwThumb === 'Down' && assignedScore > threshold.max) {
        flags.push({
          type: 'bww_mismatch',
          severity: 'high',
          message: `BWW "Down" but score ${assignedScore} > ${threshold.max}`,
          expected: `<= ${threshold.max}`,
          actual: assignedScore,
        });
      }
      if (bwwThumb === 'Meh' && (assignedScore < threshold.min || assignedScore > threshold.max)) {
        flags.push({
          type: 'bww_mismatch',
          severity: 'medium',
          message: `BWW "Meh" but score ${assignedScore} outside ${threshold.min}-${threshold.max}`,
          expected: `${threshold.min}-${threshold.max}`,
          actual: assignedScore,
        });
      }
    }
  }

  // Validate against original rating
  const parsedRating = parseOriginalRating(originalRating || originalScore);
  if (parsedRating && parsedRating.range) {
    const { min, max } = parsedRating.range;
    if (assignedScore < min || assignedScore > max) {
      flags.push({
        type: 'rating_mismatch',
        severity: 'high',
        message: `Original rating ${parsedRating.value} (${parsedRating.type}) expects ${min}-${max}, got ${assignedScore}`,
        expected: `${min}-${max}`,
        actual: assignedScore,
        originalValue: parsedRating.value,
      });
    }
  }

  // Check for conflicting aggregator thumbs
  if (dtliThumb && bwwThumb && dtliThumb !== bwwThumb) {
    // Only flag if they're opposite (Up vs Down)
    if ((dtliThumb === 'Up' && bwwThumb === 'Down') || (dtliThumb === 'Down' && bwwThumb === 'Up')) {
      flags.push({
        type: 'aggregator_conflict',
        severity: 'medium',
        message: `DTLI says "${dtliThumb}" but BWW says "${bwwThumb}"`,
        dtliThumb,
        bwwThumb,
      });
    }
  }

  return {
    flags,
    severity: flags.length === 0 ? 'ok' : flags.some(f => f.severity === 'high') ? 'high' : 'medium',
  };
}

async function main() {
  console.log('Score Validation Script\n');
  console.log('=' .repeat(60));

  const files = getAllReviewFiles();
  console.log(`Found ${files.length} review files\n`);

  const results = {
    timestamp: new Date().toISOString(),
    totalReviews: files.length,
    validated: 0,
    withFlags: 0,
    highSeverity: 0,
    mediumSeverity: 0,
    byType: {},
    flaggedReviews: [],
    summary: {
      dtliMismatches: [],
      bwwMismatches: [],
      ratingMismatches: [],
      aggregatorConflicts: [],
    },
  };

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const review = JSON.parse(content);

      const validation = validateReview(filePath, review);
      results.validated++;

      if (validation.flags.length > 0) {
        results.withFlags++;

        if (validation.severity === 'high') results.highSeverity++;
        else if (validation.severity === 'medium') results.mediumSeverity++;

        const entry = {
          file: path.relative(REVIEW_TEXTS_DIR, filePath),
          showId: review.showId,
          outlet: review.outlet,
          criticName: review.criticName,
          assignedScore: review.assignedScore,
          dtliThumb: review.dtliThumb || null,
          bwwThumb: review.bwwThumb || null,
          originalRating: review.originalRating || review.originalScore || null,
          flags: validation.flags,
          severity: validation.severity,
        };

        results.flaggedReviews.push(entry);

        // Categorize by type
        for (const flag of validation.flags) {
          results.byType[flag.type] = (results.byType[flag.type] || 0) + 1;

          if (flag.type === 'dtli_mismatch') {
            results.summary.dtliMismatches.push(entry);
          } else if (flag.type === 'bww_mismatch') {
            results.summary.bwwMismatches.push(entry);
          } else if (flag.type === 'rating_mismatch') {
            results.summary.ratingMismatches.push(entry);
          } else if (flag.type === 'aggregator_conflict') {
            results.summary.aggregatorConflicts.push(entry);
          }
        }
      }
    } catch (err) {
      console.error(`Error processing ${filePath}: ${err.message}`);
    }
  }

  // Sort flagged reviews by severity
  results.flaggedReviews.sort((a, b) => {
    if (a.severity === 'high' && b.severity !== 'high') return -1;
    if (b.severity === 'high' && a.severity !== 'high') return 1;
    return 0;
  });

  // Print summary
  console.log('\nVALIDATION SUMMARY');
  console.log('=' .repeat(60));
  console.log(`Total reviews:     ${results.totalReviews}`);
  console.log(`Validated:         ${results.validated}`);
  console.log(`With flags:        ${results.withFlags}`);
  console.log(`High severity:     ${results.highSeverity}`);
  console.log(`Medium severity:   ${results.mediumSeverity}`);
  console.log('');
  console.log('BY FLAG TYPE:');
  for (const [type, count] of Object.entries(results.byType)) {
    console.log(`  ${type}: ${count}`);
  }

  // Print high severity issues
  if (results.highSeverity > 0) {
    console.log('\n\nHIGH SEVERITY MISMATCHES (Top 20)');
    console.log('=' .repeat(60));

    const highSeverity = results.flaggedReviews.filter(r => r.severity === 'high').slice(0, 20);
    for (const review of highSeverity) {
      console.log(`\n${review.showId} / ${review.outlet}`);
      console.log(`  Score: ${review.assignedScore}`);
      if (review.dtliThumb) console.log(`  DTLI: ${review.dtliThumb}`);
      if (review.bwwThumb) console.log(`  BWW: ${review.bwwThumb}`);
      if (review.originalRating) console.log(`  Original: ${review.originalRating}`);
      for (const flag of review.flags) {
        console.log(`  ⚠️  ${flag.message}`);
      }
    }
  }

  // Save report
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const reportPath = path.join(AUDIT_DIR, 'score-validation.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n\nFull report saved to: ${reportPath}`);

  // Also save a simpler CSV-like summary for quick reference
  const csvLines = ['showId,outlet,assignedScore,dtliThumb,bwwThumb,originalRating,flags'];
  for (const review of results.flaggedReviews.slice(0, 100)) {
    const flags = review.flags.map(f => f.type).join(';');
    csvLines.push(`${review.showId},${review.outlet},${review.assignedScore},${review.dtliThumb || ''},${review.bwwThumb || ''},${review.originalRating || ''},${flags}`);
  }
  const csvPath = path.join(AUDIT_DIR, 'score-validation-summary.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`Summary CSV saved to: ${csvPath}`);

  return results;
}

main().catch(console.error);
