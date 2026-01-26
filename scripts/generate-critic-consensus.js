#!/usr/bin/env node

/**
 * Generate Critic Consensus for all shows using Claude API
 * Similar to Rotten Tomatoes' editorial summaries
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

  const prompt = `You are writing a Critic Consensus for the Broadway show "${showTitle}" - a 2-sentence editorial summary similar to Rotten Tomatoes' format.

Based on these ${reviews.length} critic reviews, write a 2-sentence summary that captures the overall critical reception. The summary should:
- Be exactly 2 sentences (no more, no less)
- Capture the general sentiment (positive, mixed, or negative)
- Mention specific praised/criticized elements (performances, direction, writing, etc.)
- Be objective and factual, not promotional
- Use present tense
- Not mention specific critic names or outlets

Reviews:
${reviewSummaries}

Write only the 2-sentence consensus, nothing else.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    temperature: 0.7,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const consensus = message.content[0].text.trim();

  // Validate it's roughly 2 sentences (allow some flexibility)
  const sentenceCount = (consensus.match(/[.!?]+/g) || []).length;
  if (sentenceCount < 2 || sentenceCount > 3) {
    console.warn(`  ⚠️  Generated ${sentenceCount} sentences instead of 2, but proceeding...`);
  }

  return consensus;
}

/**
 * Main execution
 */
async function main() {
  console.log('🎭 Generating Critic Consensus for all shows...\n');

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
    description: "LLM-generated critic consensus summaries for shows (2-sentence editorial)",
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
