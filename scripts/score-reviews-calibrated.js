#!/usr/bin/env node

/**
 * Calibrated LLM Review Scoring
 *
 * Uses few-shot examples from reviews with known original ratings
 * to improve scoring accuracy.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/score-reviews-calibrated.js
 *
 * Options:
 *   --show=hamilton-2015    Only process one show
 *   --dry-run               Don't save, just print results
 *   --limit=10              Only process N reviews
 *   --force                 Re-score even if already scored
 *   --calibration-only      Only score the calibration set
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const reviewsDir = path.join(__dirname, '../data/review-texts');
const llmScoresDir = path.join(__dirname, '../data/llm-scores');
const calibrationPath = path.join(__dirname, '../data/calibration/calibration-set.json');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const calibrationOnly = args.includes('--calibration-only');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

// Star rating to expected score ranges - used for validation
const STAR_RANGES = {
  '5/5': { min: 85, max: 100, midpoint: 92.5 },
  '4/5': { min: 72, max: 88, midpoint: 80 },
  '3/5': { min: 55, max: 72, midpoint: 63.5 },
  '2/5': { min: 35, max: 55, midpoint: 45 },
  '1/5': { min: 0, max: 35, midpoint: 17.5 },
};

// Calibrated scoring prompt with few-shot examples
const SCORING_PROMPT = `You are an expert theater critic review analyzer. Your task is to assign a numerical score (0-100) based on how positive or negative a review is.

## SCORE CALIBRATION GUIDE

Scores must align with these star rating equivalents:
- 85-100 (★★★★★ - 5/5): Rave review. Unqualified praise, superlatives like "masterpiece," "triumph," "unmissable"
- 72-88 (★★★★☆ - 4/5): Strong positive. Enthusiastic recommendation with minor quibbles
- 55-72 (★★★☆☆ - 3/5): Mixed-positive. Generally favorable but significant reservations
- 35-55 (★★☆☆☆ - 2/5): Mixed-negative to negative. More criticisms than praise
- 0-35 (★☆☆☆☆ - 1/5): Pan. Harsh criticism, does not recommend

## FEW-SHOT EXAMPLES

### Example 1: 5/5 Stars (Score: 90)
REVIEW: "Daniel Aukin's superb production navigates the change without missing a beat. The jam has been preserved. There's nary a false note. The result is richly satisfying multitrack production."
ANALYSIS: Superlatives throughout ("superb," "richly satisfying"), no criticisms mentioned.
SCORE: 90 (5/5 range)

### Example 2: 4/5 Stars (Score: 80)
REVIEW: "An impressive achievement with strong performances across the board. While the second act drags slightly, the overall experience is highly recommended."
ANALYSIS: Strong recommendation with minor criticism (pacing issue).
SCORE: 80 (4/5 range)

### Example 3: 3/5 Stars (Score: 65)
REVIEW: "The production has moments of brilliance, particularly in the choreography, but the book remains problematic and the score is unmemorable. Worth seeing for fans but not essential."
ANALYSIS: Significant reservations alongside genuine praise. Qualified recommendation.
SCORE: 65 (3/5 range)

### Example 4: 2/5 Stars (Score: 45)
REVIEW: "Despite a game cast, this production never finds its footing. The direction is unfocused and the material feels dated. A few bright spots cannot save the evening."
ANALYSIS: More negative than positive. Does not recommend.
SCORE: 45 (2/5 range)

### Example 5: 1/5 Stars (Score: 25)
REVIEW: "A hollow spectacle that wastes its talented performers. The book is a mess, the songs forgettable, and the direction tone-deaf. Save your money."
ANALYSIS: Harsh criticism throughout with explicit negative recommendation.
SCORE: 25 (1/5 range)

## YOUR TASK

Read the following review and:
1. Identify key positive and negative phrases
2. Determine if there's an explicit recommendation (positive or negative)
3. Assign a score that maps to the appropriate star rating

Respond with ONLY a JSON object:
{
  "score": <number 0-100>,
  "bucket": "<Rave|Positive|Mixed|Negative|Pan>",
  "thumb": "<Up|Meh|Down>",
  "confidence": "<high|medium|low>",
  "keyPhrases": [{"text": "...", "sentiment": "positive|negative"}],
  "reasoning": "Brief explanation of score"
}

THE REVIEW TO SCORE:
`;

async function scoreReview(client, reviewText, showId, outlet) {
  // Validate text before scoring
  if (!reviewText || reviewText.length < 100) {
    return {
      score: null,
      error: 'insufficient_text',
      message: `Review text too short (${reviewText?.length || 0} chars)`,
    };
  }

  // Truncate very long reviews
  const truncatedText = reviewText.length > 4000 ? reviewText.substring(0, 4000) + '...' : reviewText;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: SCORING_PROMPT + `Show: ${showId}\nOutlet: ${outlet}\n\n${truncatedText}`
      }
    ]
  });

  const text = response.content[0].text.trim();

  // Parse JSON response
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      result.inputTokens = response.usage?.input_tokens || 0;
      result.outputTokens = response.usage?.output_tokens || 0;
      return result;
    }
  } catch (e) {
    console.error('Failed to parse response:', text);
    return { score: null, error: 'parse_error', rawResponse: text };
  }

  return { score: null, error: 'no_json', rawResponse: text };
}

function validateScore(result, review) {
  const flags = [];

  // Check against original rating if available
  const originalScore = review.originalScore || review.originalRating;
  if (originalScore) {
    const match = String(originalScore).match(/(\d+)\/(\d+)/);
    if (match) {
      const normalizedRating = `${match[1]}/${match[2]}`;
      const range = STAR_RANGES[normalizedRating];
      if (range && result.score !== null) {
        if (result.score < range.min || result.score > range.max) {
          flags.push({
            type: 'original_rating_mismatch',
            originalRating: normalizedRating,
            expectedRange: `${range.min}-${range.max}`,
            actualScore: result.score,
          });
        }
      }
    }
  }

  // Check against DTLI thumb
  if (review.dtliThumb && result.thumb) {
    const thumbMap = { Up: 'Up', Meh: 'Meh', Down: 'Down' };
    if (thumbMap[review.dtliThumb] !== result.thumb) {
      // Only flag significant mismatches
      if ((review.dtliThumb === 'Up' && result.thumb === 'Down') ||
          (review.dtliThumb === 'Down' && result.thumb === 'Up')) {
        flags.push({
          type: 'dtli_thumb_mismatch',
          dtliThumb: review.dtliThumb,
          llmThumb: result.thumb,
        });
      }
    }
  }

  // Check against BWW thumb
  if (review.bwwThumb && result.thumb) {
    if ((review.bwwThumb === 'Up' && result.thumb === 'Down') ||
        (review.bwwThumb === 'Down' && result.thumb === 'Up')) {
      flags.push({
        type: 'bww_thumb_mismatch',
        bwwThumb: review.bwwThumb,
        llmThumb: result.thumb,
      });
    }
  }

  return flags;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... node scripts/score-reviews-calibrated.js');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Create llm-scores directory
  fs.mkdirSync(llmScoresDir, { recursive: true });

  // Get files to process
  let filesToProcess = [];

  if (calibrationOnly) {
    // Only process calibration set
    if (!fs.existsSync(calibrationPath)) {
      console.error('Calibration set not found. Run build-calibration-set.js first.');
      process.exit(1);
    }
    const calibration = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
    filesToProcess = calibration.calibrationSet.map(item => ({
      showId: item.showId,
      file: item.file.split('/')[1],
      filePath: path.join(reviewsDir, item.file),
      hasOriginalScore: true,
      originalScore: item.originalScore,
    }));
    console.log(`Processing calibration set: ${filesToProcess.length} reviews\n`);
  } else {
    // Process all reviews
    const shows = fs.readdirSync(reviewsDir).filter(f =>
      fs.statSync(path.join(reviewsDir, f)).isDirectory()
    );

    const targetShows = showFilter ? shows.filter(s => s === showFilter) : shows;

    for (const show of targetShows) {
      const showDir = path.join(reviewsDir, show);
      const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        filesToProcess.push({
          showId: show,
          file,
          filePath: path.join(showDir, file),
        });
      }
    }
  }

  if (showFilter && !calibrationOnly && filesToProcess.length === 0) {
    console.error(`Show not found: ${showFilter}`);
    process.exit(1);
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];

  console.log(`Scoring reviews with calibrated LLM prompt...`);
  console.log(`Files to process: ${filesToProcess.length}`);
  if (dryRun) console.log('DRY RUN - no files will be modified\n');

  for (const item of filesToProcess) {
    if (limit && processed >= limit) {
      console.log(`\nLimit of ${limit} reached.`);
      break;
    }

    const review = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));

    // Skip if already has LLM score (unless force)
    if (review.llmScore?.score !== undefined && !force) {
      skipped++;
      continue;
    }

    // Get text to score
    const text = review.fullText || review.dtliExcerpt || review.bwwExcerpt;
    if (!text || text.length < 100) {
      console.log(`  Skipping ${item.showId}/${item.file} - insufficient text (${text?.length || 0} chars)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ${item.showId}/${item.file}... `);

    try {
      const result = await scoreReview(client, text, item.showId, review.outlet);

      if (result.score !== null) {
        // Validate against known data
        const flags = validateScore(result, review);

        // Build LLM score object
        const llmScoreData = {
          score: result.score,
          bucket: result.bucket,
          thumb: result.thumb,
          confidence: result.confidence,
          keyPhrases: result.keyPhrases,
          reasoning: result.reasoning,
          flags,
          scoredAt: new Date().toISOString(),
          promptVersion: '3.0.0-calibrated',
        };

        // Save to review file (inline)
        review.llmScore = llmScoreData;
        review.llmMetadata = {
          model: 'claude-sonnet-4-20250514',
          scoredAt: llmScoreData.scoredAt,
          promptVersion: llmScoreData.promptVersion,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };

        if (!dryRun) {
          fs.writeFileSync(item.filePath, JSON.stringify(review, null, 2));
        }

        // Also save to llm-scores directory
        const llmScorePath = path.join(llmScoresDir, item.showId);
        fs.mkdirSync(llmScorePath, { recursive: true });
        const scoreFile = path.join(llmScorePath, item.file);
        if (!dryRun) {
          fs.writeFileSync(scoreFile, JSON.stringify({
            showId: review.showId,
            outletId: review.outletId,
            outlet: review.outlet,
            criticName: review.criticName,
            ...llmScoreData,
            originalScore: review.originalScore || review.originalRating || null,
            dtliThumb: review.dtliThumb || null,
            bwwThumb: review.bwwThumb || null,
          }, null, 2));
        }

        const flagStr = flags.length > 0 ? ` [${flags.length} flags]` : '';
        console.log(`${result.score} (${result.bucket})${flagStr}`);

        results.push({
          showId: item.showId,
          outlet: review.outlet,
          score: result.score,
          bucket: result.bucket,
          originalScore: item.originalScore,
          flags,
        });

        processed++;
      } else {
        console.log(`FAILED: ${result.error}`);
        errors++;
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }

    // Rate limiting - wait 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n========================================`);
  console.log(`Processed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  // If calibration only, output accuracy report
  if (calibrationOnly && results.length > 0) {
    console.log(`\n========================================`);
    console.log('CALIBRATION ACCURACY REPORT\n');

    let inRange = 0;
    let total = 0;

    for (const r of results) {
      if (r.originalScore) {
        const range = STAR_RANGES[r.originalScore];
        if (range) {
          total++;
          const ok = r.score >= range.min && r.score <= range.max;
          if (ok) inRange++;

          const status = ok ? '✓' : `✗ (expected ${range.min}-${range.max})`;
          console.log(`  ${r.showId} / ${r.outlet}`);
          console.log(`    Original: ${r.originalScore}, LLM: ${r.score} ${status}`);
        }
      }
    }

    console.log(`\nAccuracy: ${inRange}/${total} (${Math.round(100 * inRange / total)}%)`);
    console.log(`Target: 70%`);
    if (inRange / total >= 0.7) {
      console.log('✓ Calibration target achieved!');
    } else {
      console.log('✗ Calibration target not met. Prompt needs adjustment.');
    }
  }
}

main().catch(console.error);
