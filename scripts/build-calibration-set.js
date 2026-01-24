#!/usr/bin/env node
/**
 * Build Calibration Set Script
 * Extracts reviews with clear original ratings to create a calibration set
 * for testing and improving LLM scoring accuracy.
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'calibration');

// Star rating to expected score ranges
const STAR_RANGES = {
  '5/5': { min: 85, max: 100, midpoint: 92.5 },
  '4/5': { min: 72, max: 88, midpoint: 80 },
  '3/5': { min: 55, max: 72, midpoint: 63.5 },
  '2/5': { min: 35, max: 55, midpoint: 45 },
  '1/5': { min: 0, max: 35, midpoint: 17.5 },
};

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

function parseStarRating(score) {
  if (!score) return null;
  const match = String(score).match(/(\d+)\/(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

function getTextQuality(review) {
  const text = review.fullText || review.dtliExcerpt || review.bwwExcerpt || '';
  const wordCount = text.split(/\s+/).length;

  if (wordCount >= 300) return 'full';
  if (wordCount >= 100) return 'partial';
  if (wordCount >= 30) return 'excerpt';
  return 'minimal';
}

async function main() {
  console.log('Building Calibration Set\n');
  console.log('=' .repeat(60));

  const files = getAllReviewFiles();
  console.log(`Scanning ${files.length} review files...\n`);

  const calibrationCandidates = [];
  const byRating = {
    '5/5': [],
    '4/5': [],
    '3/5': [],
    '2/5': [],
    '1/5': [],
  };

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const review = JSON.parse(content);

      const originalScore = parseStarRating(review.originalScore || review.originalRating);
      if (!originalScore || !STAR_RANGES[originalScore]) continue;

      const textQuality = getTextQuality(review);
      if (textQuality === 'minimal') continue; // Skip reviews with too little text

      const range = STAR_RANGES[originalScore];
      const candidate = {
        file: path.relative(REVIEW_TEXTS_DIR, filePath),
        showId: review.showId,
        outlet: review.outlet,
        criticName: review.criticName,
        originalScore,
        expectedRange: range,
        expectedMidpoint: range.midpoint,
        assignedScore: review.assignedScore,
        llmScore: review.llmScore?.score || null,
        dtliThumb: review.dtliThumb || null,
        bwwThumb: review.bwwThumb || null,
        textQuality,
        hasFullText: !!review.fullText && review.fullText.length > 500,
        textLength: (review.fullText || review.dtliExcerpt || review.bwwExcerpt || '').length,
      };

      // Check if assigned score matches expected range
      if (candidate.assignedScore !== null) {
        candidate.assignedInRange = candidate.assignedScore >= range.min && candidate.assignedScore <= range.max;
        candidate.assignedDelta = candidate.assignedScore - range.midpoint;
      }

      // Check if LLM score matches expected range
      if (candidate.llmScore !== null) {
        candidate.llmInRange = candidate.llmScore >= range.min && candidate.llmScore <= range.max;
        candidate.llmDelta = candidate.llmScore - range.midpoint;
      }

      calibrationCandidates.push(candidate);
      byRating[originalScore].push(candidate);
    } catch (err) {
      // Skip invalid files
    }
  }

  console.log('CANDIDATES BY RATING:');
  for (const [rating, candidates] of Object.entries(byRating)) {
    const range = STAR_RANGES[rating];
    const withFullText = candidates.filter(c => c.hasFullText).length;
    console.log(`  ${rating}: ${candidates.length} total (${withFullText} with full text) - expected ${range.min}-${range.max}`);
  }

  // Build balanced calibration set (aim for 4-5 per rating bucket)
  const calibrationSet = [];
  const TARGET_PER_BUCKET = 4;

  for (const [rating, candidates] of Object.entries(byRating)) {
    // Prioritize reviews with full text
    const sorted = candidates.sort((a, b) => {
      if (a.hasFullText && !b.hasFullText) return -1;
      if (!a.hasFullText && b.hasFullText) return 1;
      return b.textLength - a.textLength;
    });

    const selected = sorted.slice(0, TARGET_PER_BUCKET);
    calibrationSet.push(...selected);
  }

  console.log(`\nCalibration set: ${calibrationSet.length} reviews\n`);

  // Analyze current accuracy
  let assignedCorrect = 0;
  let assignedTotal = 0;
  let llmCorrect = 0;
  let llmTotal = 0;

  for (const item of calibrationSet) {
    if (item.assignedScore !== null) {
      assignedTotal++;
      if (item.assignedInRange) assignedCorrect++;
    }
    if (item.llmScore !== null) {
      llmTotal++;
      if (item.llmInRange) llmCorrect++;
    }
  }

  console.log('CURRENT ACCURACY (in-range):');
  console.log(`  Assigned scores: ${assignedCorrect}/${assignedTotal} (${assignedTotal > 0 ? Math.round(100 * assignedCorrect / assignedTotal) : 0}%)`);
  console.log(`  LLM scores: ${llmCorrect}/${llmTotal} (${llmTotal > 0 ? Math.round(100 * llmCorrect / llmTotal) : 0}%)`);

  // Print detailed analysis
  console.log('\n\nDETAILED CALIBRATION SET:');
  console.log('=' .repeat(80));

  for (const item of calibrationSet) {
    const range = item.expectedRange;
    const assignedStatus = item.assignedScore === null ? 'MISSING' :
      item.assignedInRange ? 'OK' : `OUT (delta: ${item.assignedDelta > 0 ? '+' : ''}${item.assignedDelta.toFixed(0)})`;
    const llmStatus = item.llmScore === null ? 'MISSING' :
      item.llmInRange ? 'OK' : `OUT (delta: ${item.llmDelta > 0 ? '+' : ''}${item.llmDelta.toFixed(0)})`;

    console.log(`\n${item.showId} / ${item.outlet}`);
    console.log(`  Original: ${item.originalScore} → expected ${range.min}-${range.max}`);
    console.log(`  Assigned: ${item.assignedScore ?? 'null'} [${assignedStatus}]`);
    console.log(`  LLM:      ${item.llmScore ?? 'null'} [${llmStatus}]`);
    if (item.dtliThumb) console.log(`  DTLI:     ${item.dtliThumb}`);
    if (item.bwwThumb) console.log(`  BWW:      ${item.bwwThumb}`);
    console.log(`  Text:     ${item.textQuality} (${item.textLength} chars)`);
  }

  // Save calibration set
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const output = {
    timestamp: new Date().toISOString(),
    totalCandidates: calibrationCandidates.length,
    calibrationSetSize: calibrationSet.length,
    byRating: Object.fromEntries(
      Object.entries(byRating).map(([k, v]) => [k, v.length])
    ),
    accuracy: {
      assigned: {
        correct: assignedCorrect,
        total: assignedTotal,
        percentage: assignedTotal > 0 ? Math.round(100 * assignedCorrect / assignedTotal) : 0,
      },
      llm: {
        correct: llmCorrect,
        total: llmTotal,
        percentage: llmTotal > 0 ? Math.round(100 * llmCorrect / llmTotal) : 0,
      },
    },
    starRanges: STAR_RANGES,
    calibrationSet,
  };

  const outputPath = path.join(OUTPUT_DIR, 'calibration-set.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n\nCalibration set saved to: ${outputPath}`);

  // Generate calibration prompts file with examples
  const promptExamples = calibrationSet.map(item => {
    const review = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, item.file), 'utf8'));
    const text = review.fullText || review.dtliExcerpt || review.bwwExcerpt || '';
    return {
      showId: item.showId,
      outlet: item.outlet,
      originalScore: item.originalScore,
      expectedRange: item.expectedRange,
      text: text.substring(0, 1500), // Truncate for prompt examples
    };
  });

  const examplesPath = path.join(OUTPUT_DIR, 'calibration-examples.json');
  fs.writeFileSync(examplesPath, JSON.stringify(promptExamples, null, 2));
  console.log(`Calibration examples saved to: ${examplesPath}`);

  return output;
}

main().catch(console.error);
