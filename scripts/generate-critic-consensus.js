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

      // Skip reviews flagged as wrong production or wrong show
      if (data.wrongProduction || data.wrongShow) continue;

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
          hasFullText: !!data.fullText,
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
 * Determine if a show's consensus should be regenerated.
 * Returns { should: boolean, reason: string }
 */
function shouldRegenerate(existing, reviews) {
  if (!existing) return { should: true, reason: 'new show (no existing consensus)' };

  const currentReviewCount = reviews.length;
  const currentFullTextCount = reviews.filter(r => r.hasFullText).length;
  const scoredReviews = reviews.filter(r => r.score != null);
  const currentMeanScore = scoredReviews.length > 0
    ? Math.round(scoredReviews.reduce((a, r) => a + r.score, 0) / scoredReviews.length)
    : null;

  // Trigger 1: New reviews added (existing behavior)
  const reviewCountDiff = currentReviewCount - (existing.reviewCount || 0);
  if (reviewCountDiff >= 3) {
    return { should: true, reason: `${reviewCountDiff} new reviews` };
  }

  // Trigger 2: Full text upgrades (excerpt → full text)
  if (existing.fullTextCount != null) {
    const fullTextGain = currentFullTextCount - existing.fullTextCount;
    if (fullTextGain >= 3) {
      return { should: true, reason: `${fullTextGain} reviews upgraded to full text` };
    }
  }

  // Trigger 3: Reviews removed (wrongProduction flags, etc.)
  if (reviewCountDiff <= -2) {
    return { should: true, reason: `${Math.abs(reviewCountDiff)} reviews removed` };
  }

  // Trigger 4: Mean score drift (rescoring, rave calibration)
  if (existing.meanScore != null && currentMeanScore != null) {
    const scoreDrift = Math.abs(currentMeanScore - existing.meanScore);
    if (scoreDrift >= 8) {
      return { should: true, reason: `mean score shifted ${scoreDrift}pts (${existing.meanScore} → ${currentMeanScore})` };
    }
  }

  return { should: false };
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
  const cleanupOrphans = process.argv.includes('--cleanup-orphans');

  // Parse --show=X filter (single-show mode for opening night, etc.)
  const showArg = process.argv.find(a => a.startsWith('--show='));
  const showFilter = showArg ? showArg.split('=')[1].replace(/['"]/g, '') : null;

  // Parse --max-shows=N cap (cost control)
  const maxShowsArg = process.argv.find(a => a.startsWith('--max-shows='));
  const maxShows = maxShowsArg ? parseInt(maxShowsArg.split('=')[1], 10) : 0; // 0 = unlimited

  if (showFilter) console.log(`🎯 Single-show mode: ${showFilter}\n`);
  if (maxShows > 0) console.log(`📊 Max shows cap: ${maxShows}\n`);

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Build show ID set for existence checks
  const showIdSet = new Set(showsData.shows.map(s => s.id));
  const showStatusMap = {};
  for (const s of showsData.shows) {
    showStatusMap[s.id] = s.status;
  }

  // Layer 5c: Orphan cleanup — remove consensus for shows not in shows.json
  {
    const orphanIds = Object.keys(consensusData.shows).filter(id => !showIdSet.has(id));
    if (orphanIds.length > 0) {
      if (cleanupOrphans) {
        console.log(`🧹 Removing ${orphanIds.length} orphaned consensus entries:`);
        for (const id of orphanIds) {
          console.log(`  - ${id}`);
          delete consensusData.shows[id];
        }
      } else {
        console.log(`⚠️  Found ${orphanIds.length} orphaned consensus entries (show not in shows.json):`);
        orphanIds.slice(0, 5).forEach(id => console.log(`  - ${id}`));
        if (orphanIds.length > 5) console.log(`  ... and ${orphanIds.length - 5} more`);
        console.log('  Run with --cleanup-orphans to remove them.\n');
      }
    }
  }

  for (const show of showsData.shows) {
    const showId = show.id;
    const showTitle = show.title;

    // --show filter: skip non-matching shows
    if (showFilter && showId !== showFilter) continue;

    // Max shows cap: stop after N generations
    if (maxShows > 0 && processedCount >= maxShows) {
      console.log(`\n⚠️  Reached max-shows cap (${maxShows}). Stopping.`);
      break;
    }

    console.log(`\n📖 ${showTitle} (${showId})`);

    // Load reviews
    const reviews = loadReviewTexts(showId);

    // Layer 5a: Input validation — minimum review threshold
    const scoredReviews = reviews.filter(r => r.score != null);
    if (scoredReviews.length < 2) {
      console.log(`  ⏭️  Skipped - only ${scoredReviews.length} scored reviews (need 2+)`);
      // Delete stale consensus if show dropped below threshold
      if (consensusData.shows[showId] && (consensusData.shows[showId].reviewCount || 0) >= 2) {
        console.log(`  🗑️  Removing stale consensus (reviews dropped below threshold)`);
        delete consensusData.shows[showId];
      }
      skippedCount++;
      continue;
    }

    // Layer 5a: Input validation — previews guard
    if (showStatusMap[showId] === 'previews' && scoredReviews.length === 0) {
      console.log(`  ⏭️  Skipped - previews show with 0 scored reviews`);
      skippedCount++;
      continue;
    }

    if (reviews.length === 0) {
      console.log(`  ⏭️  Skipped - no review texts available`);
      skippedCount++;
      continue;
    }

    // Check if we should regenerate (multi-trigger)
    const existing = consensusData.shows[showId];
    if (existing && !force) {
      const result = shouldRegenerate(existing, reviews);
      if (!result.should) {
        console.log(`  ⏭️  Skipped - no significant changes`);
        skippedCount++;
        continue;
      }
      console.log(`  🔄 Regenerating - ${result.reason}`);
    }

    try {
      // Generate consensus
      console.log(`  🤖 Generating consensus from ${reviews.length} reviews...`);
      const consensus = await generateConsensus(showTitle, reviews);

      // Layer 5b: Output validation — LLM refusal detection
      const REFUSAL_PATTERNS = [
        /I apologize/i,
        /I cannot provide/i,
        /I'm unable/i,
        /I can't generate/i,
        /based on these reviews/i,
        /I don't have enough/i,
        /As an AI/i,
      ];
      const isRefusal = REFUSAL_PATTERNS.some(p => p.test(consensus));
      if (isRefusal) {
        console.warn(`  ⚠️  LLM refusal detected — skipping: "${consensus.slice(0, 80)}..."`);
        errorCount++;
        continue;
      }

      // Layer 5b: Output validation — length check (> 280 chars = too long)
      let finalText = consensus;
      if (consensus.length > 280) {
        console.warn(`  ⚠️  Generated ${consensus.length} chars (max 280) — truncating at sentence boundary`);
        const truncated = consensus.substring(0, 280);
        const lastSentence = truncated.lastIndexOf('.');
        finalText = lastSentence > 100 ? truncated.substring(0, lastSentence + 1) : truncated;
      }

      // Build fingerprint for change detection on future runs
      const fullTextCount = reviews.filter(r => r.hasFullText).length;
      const scoredForMean = reviews.filter(r => r.score != null);
      const meanScore = scoredForMean.length > 0
        ? Math.round(scoredForMean.reduce((a, r) => a + r.score, 0) / scoredForMean.length)
        : null;

      consensusData.shows[showId] = {
        text: finalText,
        lastUpdated: new Date().toISOString().split('T')[0],
        reviewCount: reviews.length,
        fullTextCount,
        meanScore,
      };

      console.log(`  ✅ Generated: "${(consensusData.shows[showId].text).slice(0, 80)}..."`);
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
    updatePolicy: "Auto-regenerate on: 3+ new reviews, 3+ full-text upgrades, 2+ reviews removed, or 8+ pt mean score drift",
  };

  fs.writeFileSync(CONSENSUS_FILE, JSON.stringify(consensusData, null, 2));

  console.log(`\n\n✅ Done!`);
  console.log(`   Processed: ${processedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Errors: ${errorCount}`);
  if (maxShows > 0) console.log(`   Max shows cap: ${maxShows}`);
  console.log(`\n💾 Saved to: ${path.relative(ROOT, CONSENSUS_FILE)}`);

  if (force) {
    console.log(`\n💡 Used --force flag to regenerate all shows`);
  } else {
    console.log(`\n💡 Use --force to regenerate all shows regardless of triggers`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
