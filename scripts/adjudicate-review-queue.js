#!/usr/bin/env node

/**
 * Adjudicate Review Queue
 *
 * Auto-resolves flagged reviews where LLM scores disagree with aggregator thumbs.
 * Reads needs-human-review.json (produced by rebuild-all-reviews.js at 4 AM),
 * calls Claude Sonnet to re-evaluate each review, and writes humanReviewScore
 * to source files when confident.
 *
 * After 3 uncertain adjudication attempts, auto-accepts the LLM original score
 * to permanently clear the review from the queue.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = path.join(ROOT, 'data', 'audit', 'needs-human-review.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

const MAX_ADJUDICATION_ATTEMPTS = 3;
const DRY_RUN = process.argv.includes('--dry-run');

// Bucket score ranges (from scripts/llm-scoring/config.ts)
const BUCKET_RANGES = {
  Rave: { min: 85, max: 100 },
  Positive: { min: 70, max: 84 },
  Mixed: { min: 55, max: 69 },
  Negative: { min: 35, max: 54 },
  Pan: { min: 0, max: 34 }
};

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Build the adjudication system prompt
 */
function buildSystemPrompt() {
  return `You are an expert Broadway theater review adjudicator. Your job is to resolve disagreements between an automated LLM scoring system and human aggregator editors about how positive or negative a review is.

## Context

Broadway Scorecard aggregates critic reviews and scores them 0-100. When the LLM score and aggregator thumbs (Up/Flat/Down) disagree, the review is flagged for adjudication.

## Your Task

Read the review text carefully and determine the correct sentiment bucket and score.

## Scoring Buckets

| Bucket | Score Range | Description |
|--------|-------------|-------------|
| Rave | 85-100 | Enthusiastic, must-see recommendation |
| Positive | 70-84 | Recommends seeing it |
| Mixed | 55-69 | Neither recommends nor discourages |
| Negative | 35-54 | Does not recommend |
| Pan | 0-34 | Strongly negative |

## Important Guidelines

1. **VERDICT OVER SETUP**: Many reviews open negatively before delivering a positive verdict. Score the FINAL RECOMMENDATION.
2. **Aggregator editors read the full review** — their thumbs (Up/Down/Flat) carry real weight.
3. **BUT: Meh/Flat thumbs were wrong 83% of the time** in our audit. Be skeptical of Flat thumbs.
4. **PERFORMER PRAISE DOES NOT REDEEM A PAN** — score the overall verdict, not the best element.
5. **Star ratings override language** — if a critic gave 4/5 stars but sounds measured, trust the stars.
6. **Excerpt-only reviews are harder** — if you only have a short excerpt, acknowledge uncertainty.

## Output Format

Respond with ONLY this JSON (no markdown fences):
{
  "bucket": "Positive",
  "score": 78,
  "confidence": "high",
  "sidedWith": "thumbs",
  "reasoning": "1-2 sentence explanation"
}

Confidence levels:
- **high**: Clear verdict, unambiguous tone, confident in bucket placement
- **medium**: Some ambiguity but overall direction is clear
- **low**: Genuinely uncertain — mixed signals, insufficient text, or truncated review`;
}

/**
 * Build the user prompt for a specific review
 */
function buildUserPrompt(review, sourceData, showTitle) {
  const parts = [];

  parts.push(`## Review to Adjudicate`);
  parts.push(`**Show:** ${showTitle}`);
  parts.push(`**Outlet:** ${sourceData.outlet || review.outletId}`);
  parts.push(`**Critic:** ${sourceData.criticName || review.criticName || 'Unknown'}`);
  parts.push('');

  // Disagreement context
  parts.push(`## Disagreement`);
  parts.push(`**LLM Score:** ${review.llmScore} (bucket: ${review.llmBucket}, confidence: ${review.llmConfidence})`);

  const thumbParts = [];
  if (review.dtliThumb) thumbParts.push(`DTLI: ${review.dtliThumb}`);
  if (review.bwwThumb) thumbParts.push(`BWW: ${review.bwwThumb}`);
  parts.push(`**Aggregator Thumbs:** ${thumbParts.join(', ') || 'None'}`);
  parts.push(`**Reason flagged:** ${review.reason}`);
  if (review.detail) parts.push(`**Detail:** ${review.detail}`);
  parts.push('');

  // Review text
  parts.push(`## Review Text`);

  const textSources = [];
  if (sourceData.fullText) {
    // Truncate very long reviews to save tokens
    const text = sourceData.fullText.length > 3000
      ? sourceData.fullText.slice(0, 3000) + '\n[...truncated for length]'
      : sourceData.fullText;
    textSources.push(`### Full Review Text\n${text}`);
  }

  // Always include excerpts as supplementary context
  const excerptFields = ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt'];
  for (const field of excerptFields) {
    if (sourceData[field]) {
      const label = field.replace('Excerpt', '').toUpperCase();
      textSources.push(`### ${label} Excerpt\n${sourceData[field]}`);
    }
  }

  if (textSources.length === 0) {
    parts.push('**WARNING: No review text available.** Only metadata is available for this review. You should return low confidence.');
  } else {
    if (!sourceData.fullText) {
      parts.push('**Note:** Full review text is not available — only aggregator excerpts below. Be cautious with confidence.');
    }
    parts.push(textSources.join('\n\n'));
  }

  // Star rating context
  if (sourceData.originalScore) {
    parts.push(`\n### Original Rating\n${sourceData.originalScore}`);
  }

  parts.push('\nRespond with ONLY the JSON object.');
  return parts.join('\n');
}

/**
 * Parse Claude's response into a structured result
 */
function parseResponse(text) {
  try {
    // Try parsing as JSON directly
    const cleaned = text.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(cleaned);

    // Validate required fields
    if (!result.bucket || result.score == null || !result.confidence) {
      return null;
    }

    // Validate bucket
    if (!BUCKET_RANGES[result.bucket]) {
      return null;
    }

    // Clamp score to bucket range
    const range = BUCKET_RANGES[result.bucket];
    result.score = Math.max(range.min, Math.min(range.max, Math.round(result.score)));

    return result;
  } catch {
    return null;
  }
}

/**
 * Call Claude Sonnet for adjudication
 */
async function adjudicateReview(review, sourceData, showTitle) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 300,
    temperature: 0.3,
    system: buildSystemPrompt(),
    messages: [{
      role: 'user',
      content: buildUserPrompt(review, sourceData, showTitle),
    }],
  });

  const responseText = message.content[0].text;
  return parseResponse(responseText);
}

/**
 * Find the source file path for a flagged review
 */
function findSourceFile(review) {
  const showDir = path.join(REVIEW_TEXTS_DIR, review.showId);
  if (!fs.existsSync(showDir)) return null;

  // Build expected filename
  const outletId = review.outletId;
  const criticName = review.criticName;

  if (!outletId || !criticName) return null;

  const filename = `${outletId}--${criticName}.json`;
  const filePath = path.join(showDir, filename);

  if (fs.existsSync(filePath)) return filePath;

  // Try case-insensitive fallback
  const files = fs.readdirSync(showDir);
  const match = files.find(f => f.toLowerCase() === filename.toLowerCase());
  if (match) return path.join(showDir, match);

  return null;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔍 Review Queue Adjudication\n');

  if (DRY_RUN) {
    console.log('  DRY RUN — no files will be modified\n');
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }

  // Load queue
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log('No queue file found. Nothing to adjudicate.');
    process.exit(0);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));

  if (!queue.reviews || queue.reviews.length === 0) {
    console.log('Queue is empty. Nothing to adjudicate.');
    process.exit(0);
  }

  console.log(`Found ${queue.reviews.length} flagged review(s) in queue.\n`);

  // Load shows for title lookup
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const showTitleMap = {};
  for (const show of showsData.shows) {
    showTitleMap[show.id] = show.title;
  }

  // Process each flagged review
  const results = {
    resolved: 0,
    skipped: 0,
    autoAccepted: 0,
    errors: 0,
    missingFile: 0,
  };
  const changedFiles = [];

  for (const review of queue.reviews) {
    const label = `${review.showId} / ${review.outletId}--${review.criticName || 'unknown'}`;
    console.log(`\n--- ${label}`);

    // Find source file
    const filePath = findSourceFile(review);
    if (!filePath) {
      console.log('  ⚠️  Source file not found — skipping');
      results.missingFile++;
      continue;
    }

    // Load source data
    let sourceData;
    try {
      sourceData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.log(`  ⚠️  Failed to parse source file: ${err.message}`);
      results.errors++;
      continue;
    }

    // Skip if already has humanReviewScore (resolved outside this script)
    if (sourceData.humanReviewScore && sourceData.humanReviewScore >= 1) {
      console.log(`  ⏭️  Already has humanReviewScore (${sourceData.humanReviewScore}) — skipping`);
      results.skipped++;
      continue;
    }

    const attempts = sourceData.adjudicationAttempts || 0;

    // Check max attempts — auto-accept LLM score
    if (attempts >= MAX_ADJUDICATION_ATTEMPTS) {
      const llmScore = review.llmScore || (sourceData.llmScore && sourceData.llmScore.score) || 65;
      console.log(`  🔄 Max attempts reached (${attempts}) — auto-accepting LLM score: ${llmScore}`);

      if (!DRY_RUN) {
        sourceData.humanReviewScore = llmScore;
        sourceData.humanReviewNote = `Auto-accepted after ${MAX_ADJUDICATION_ATTEMPTS} uncertain adjudications - LLM original score retained`;
        sourceData.humanReviewAt = new Date().toISOString();
        sourceData.adjudicationAttempts = attempts;

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.autoAccepted++;
      continue;
    }

    // Call Claude for adjudication
    const showTitle = showTitleMap[review.showId] || review.showId;
    let result;

    try {
      result = await adjudicateReview(review, sourceData, showTitle);
    } catch (err) {
      console.log(`  ❌ API error: ${err.message}`);
      // Don't increment adjudicationAttempts on API errors (transient failure)
      results.errors++;
      continue;
    }

    if (!result) {
      console.log('  ❌ Failed to parse Claude response');
      results.errors++;
      continue;
    }

    console.log(`  Claude says: ${result.bucket} (${result.score}), confidence: ${result.confidence}, sided with: ${result.sidedWith || 'N/A'}`);
    console.log(`  Reasoning: ${result.reasoning || 'N/A'}`);

    // Build attempt record
    const attemptRecord = {
      timestamp: new Date().toISOString(),
      bucket: result.bucket,
      score: result.score,
      confidence: result.confidence,
      sidedWith: result.sidedWith || null,
      reasoning: result.reasoning || null,
    };

    if (result.confidence === 'high' || result.confidence === 'medium') {
      // Confident — write override
      console.log(`  ✅ Confident adjudication — writing humanReviewScore: ${result.score}`);

      if (!DRY_RUN) {
        sourceData.humanReviewScore = result.score;
        sourceData.humanReviewNote = `Auto-adjudicated (${result.confidence} confidence, sided with ${result.sidedWith || 'analysis'}): ${result.reasoning || ''}`.trim();
        sourceData.humanReviewPreviousScore = review.llmScore || (sourceData.llmScore && sourceData.llmScore.score) || null;
        sourceData.humanReviewAt = new Date().toISOString();
        sourceData.adjudicationAttempts = attempts + 1;
        sourceData.adjudicationHistory = [
          ...(sourceData.adjudicationHistory || []),
          attemptRecord,
        ];

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.resolved++;
    } else {
      // Low confidence — skip, increment attempts
      console.log(`  ⏳ Low confidence — skipping (attempt ${attempts + 1}/${MAX_ADJUDICATION_ATTEMPTS})`);

      if (!DRY_RUN) {
        sourceData.adjudicationAttempts = attempts + 1;
        sourceData.adjudicationHistory = [
          ...(sourceData.adjudicationHistory || []),
          attemptRecord,
        ];

        fs.writeFileSync(filePath, JSON.stringify(sourceData, null, 2) + '\n');
        changedFiles.push(filePath);
      }

      results.skipped++;
    }

    // Rate limiting — 1 second between API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log('\n\n=== ADJUDICATION SUMMARY ===\n');
  console.log(`  Resolved (confident):  ${results.resolved}`);
  console.log(`  Skipped (low conf):    ${results.skipped}`);
  console.log(`  Auto-accepted (max):   ${results.autoAccepted}`);
  console.log(`  Missing source file:   ${results.missingFile}`);
  console.log(`  Errors:                ${results.errors}`);
  console.log(`  Files changed:         ${changedFiles.length}`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — no files were modified');
  }

  // Write summary for GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## Review Queue Adjudication Results',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Resolved (confident) | ${results.resolved} |`,
      `| Skipped (low confidence) | ${results.skipped} |`,
      `| Auto-accepted (max attempts) | ${results.autoAccepted} |`,
      `| Missing source file | ${results.missingFile} |`,
      `| Errors | ${results.errors} |`,
      `| Files changed | ${changedFiles.length} |`,
      '',
      DRY_RUN ? '*Dry run — no files modified*' : '',
    ].join('\n');

    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  // Return changed count for CI use
  console.log(`\n::set-output name=changed_count::${changedFiles.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
