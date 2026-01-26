#!/usr/bin/env node

/**
 * Generate Critics' Take for all shows using Claude API
 * Concise 1-2 sentence summaries (max 280 chars) capturing critical reception
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Load review texts for a show
 */
function loadReviewTexts(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) {
    return [];
  }

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  const reviews = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));

      // Collect all available text (prefer full text, fall back to excerpts)
      const textParts = [];
      if (data.fullText) {
        textParts.push(data.fullText);
      } else {
        if (data.dtliExcerpt) textParts.push(data.dtliExcerpt);
        if (data.bwwExcerpt) textParts.push(data.bwwExcerpt);
        if (data.showScoreExcerpt) textParts.push(data.showScoreExcerpt);
      }

      if (textParts.length > 0) {
        reviews.push({
          outlet: data.outlet,
          critic: data.criticName,
          text: textParts.join('\n\n'),
          score: data.assignedScore,
          publishDate: data.publishDate,
        });
      }
    } catch (err) {
      console.warn(`  ⚠️  Failed to parse ${file}: ${err.message}`);
    }
  }

  return reviews;
}

/**
 * Generate consensus using Claude API
 */
async function generateConsensus(showTitle, reviews) {
  // Build prompt with review excerpts
  const reviewSummaries = reviews.map((r, i) => {
    const excerpt = r.text.slice(0, 500); // First 500 chars
    return `Review ${i + 1} (${r.outlet} - ${r.critic}, score: ${r.score}/100):\n${excerpt}...`;
  }).join('\n\n');

  const prompt = `You are writing a "Critics' Take" for the Broadway show "${showTitle}" - a very concise editorial summary capturing the critical reception.

Based on these ${reviews.length} critic reviews, write a brief summary (1-2 SHORT sentences, maximum 280 characters total) that captures the overall critical reception. The summary should:
- Be VERY concise and punchy (like a tweet)
- Maximum 280 characters total - keep it brief!
- Capture the general sentiment (positive, mixed, or negative)
- Mention 1-2 specific praised/criticized elements if space allows
- Be objective and factual, not promotional
- Use present tense
- Not mention specific critic names or outlets
- Get straight to the point - no unnecessary words

Reviews:
${reviewSummaries}

Write only the concise consensus (max 280 chars), nothing else.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 150,
    temperature: 0.7,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const consensus = message.content[0].text.trim();

  // Validate length and sentence count
  const sentenceCount = (consensus.match(/[.!?]+/g) || []).length;
  if (consensus.length > 300) {
    console.warn(`  ⚠️  Generated ${consensus.length} chars (target: 280 max), but proceeding...`);
  }
  if (sentenceCount > 2) {
    console.warn(`  ⚠️  Generated ${sentenceCount} sentences (target: 1-2), but proceeding...`);
  }

  return consensus;
}

/**
 * Main execution
 */
async function main() {
  console.log('🎭 Generating Critics\' Take for all shows...\n');

  // Load existing data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const consensusData = fs.existsSync(CONSENSUS_FILE)
    ? JSON.parse(fs.readFileSync(CONSENSUS_FILE, 'utf-8'))
    : { _meta: {}, shows: {} };

  const force = process.argv.includes('--force');
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const show of showsData.shows) {
    const showId = show.id;
    const showTitle = show.title;

    console.log(`\n📖 ${showTitle} (${showId})`);

    // Load reviews
    const reviews = loadReviewTexts(showId);

    if (reviews.length === 0) {
      console.log(`  ⏭️  Skipped - no review texts available`);
      skippedCount++;
      continue;
    }

    // Check if we should regenerate
    const existing = consensusData.shows[showId];
    if (existing && !force) {
      const reviewCountDiff = reviews.length - (existing.reviewCount || 0);
      if (reviewCountDiff < 3) {
        console.log(`  ⏭️  Skipped - existing consensus, only ${reviewCountDiff} new reviews (need 3+)`);
        skippedCount++;
        continue;
      }
      console.log(`  🔄 Regenerating - ${reviewCountDiff} new reviews detected`);
    }

    try {
      // Generate consensus
      console.log(`  🤖 Generating consensus from ${reviews.length} reviews...`);
      const consensus = await generateConsensus(showTitle, reviews);

      // Store result
      consensusData.shows[showId] = {
        text: consensus,
        lastUpdated: new Date().toISOString().split('T')[0],
        reviewCount: reviews.length,
      };

      console.log(`  ✅ Generated: "${consensus.slice(0, 80)}..."`);
      processedCount++;

      // Rate limiting - wait 1 second between API calls
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      errorCount++;
    }
  }

  // Update metadata and save
  consensusData._meta = {
    description: "LLM-generated Critics' Take summaries for shows (concise 1-2 sentence summary, max 280 chars)",
    lastGenerated: new Date().toISOString(),
    updatePolicy: "Regenerate weekly if 3+ new reviews added to any show",
  };

  fs.writeFileSync(CONSENSUS_FILE, JSON.stringify(consensusData, null, 2));

  console.log(`\n\n✅ Done!`);
  console.log(`   Processed: ${processedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`\n💾 Saved to: ${path.relative(ROOT, CONSENSUS_FILE)}`);

  if (force) {
    console.log(`\n💡 Used --force flag to regenerate all shows`);
  } else {
    console.log(`\n💡 Use --force to regenerate all shows regardless of update count`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
