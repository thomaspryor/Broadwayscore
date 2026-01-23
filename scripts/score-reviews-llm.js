#!/usr/bin/env node

/**
 * Score reviews using Claude LLM
 *
 * Reads each review file in data/review-texts/, sends fullText to Claude,
 * and saves the assignedScore (0-100) back to the file.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/score-reviews-llm.js
 *
 * Options:
 *   --show=hamilton-2015    Only process one show
 *   --dry-run               Don't save, just print results
 *   --limit=10              Only process N reviews
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const reviewsDir = path.join(__dirname, '../data/review-texts');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

const SCORING_PROMPT = `You are a theater critic review analyzer. Given a review excerpt, assign a score from 0-100 based on how positive or negative the review is.

Scoring guidelines:
- 90-100: Rave review. Extremely positive, uses superlatives like "masterpiece", "triumph", "unmissable", "brilliant"
- 80-89: Very positive. Enthusiastic recommendation, minor quibbles at most
- 70-79: Positive. Generally favorable, recommends the show but has some criticisms
- 60-69: Mixed-positive. More positive than negative, but significant reservations
- 50-59: Mixed. Roughly equal positives and negatives, lukewarm
- 40-49: Mixed-negative. More negative than positive
- 30-39: Negative. Generally unfavorable, does not recommend
- 20-29: Very negative. Strong criticism, few if any positives
- 0-19: Pan. Extremely negative, harsh criticism throughout

Respond with ONLY a JSON object in this exact format:
{"score": <number>, "sentiment": "<Rave|Positive|Mixed|Negative|Pan>", "confidence": "<high|medium|low>"}

The review:
`;

async function scoreReview(client, reviewText) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: SCORING_PROMPT + reviewText
      }
    ]
  });

  const text = response.content[0].text.trim();

  // Parse JSON response
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.error('Failed to parse response:', text);
  }

  return null;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... node scripts/score-reviews-llm.js');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Get all review files
  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  const targetShows = showFilter ? shows.filter(s => s === showFilter) : shows;

  if (showFilter && targetShows.length === 0) {
    console.error(`Show not found: ${showFilter}`);
    process.exit(1);
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  console.log(`Scoring reviews with Claude LLM...`);
  console.log(`Shows to process: ${targetShows.length}`);
  if (dryRun) console.log('DRY RUN - no files will be modified\n');

  for (const show of targetShows) {
    const showDir = path.join(reviewsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      if (limit && processed >= limit) {
        console.log(`\nLimit of ${limit} reached.`);
        break;
      }

      const filePath = path.join(showDir, file);
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip if already scored
      if (review.assignedScore !== null) {
        skipped++;
        continue;
      }

      // Skip if no text
      if (!review.fullText || review.fullText.length < 50) {
        console.log(`  Skipping ${file} - no text`);
        skipped++;
        continue;
      }

      process.stdout.write(`  ${show}/${file}... `);

      try {
        const result = await scoreReview(client, review.fullText);

        if (result && result.score !== undefined) {
          review.assignedScore = result.score;
          review.bucket = result.sentiment;
          review.llmConfidence = result.confidence;

          if (!dryRun) {
            fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          }

          console.log(`${result.score} (${result.sentiment})`);
          processed++;
        } else {
          console.log('FAILED');
          errors++;
        }
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
        errors++;
      }

      // Rate limiting - wait 100ms between requests
      await new Promise(r => setTimeout(r, 100));
    }

    if (limit && processed >= limit) break;
  }

  console.log(`\n========================================`);
  console.log(`Processed: ${processed}`);
  console.log(`Skipped (already scored or no text): ${skipped}`);
  console.log(`Errors: ${errors}`);
}

main().catch(console.error);
