#!/usr/bin/env npx ts-node --project /Users/tompryor/Broadwayscore/scripts/tsconfig.json
/**
 * Model Comparison Experiment
 *
 * Tests three approaches against explicit critic scores:
 * 1. Single OpenAI call
 * 2. Average of 2 OpenAI calls
 * 3. OpenAI + Claude average
 *
 * Uses all 276 reviews with explicit numeric scores.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

const ANCHORED_PROMPT = `You are a theater critic scoring system. Score this review on a 0-100 scale.

CALIBRATION ANCHORS:
- 95-100: "Masterpiece, must-see" (5 stars, A+)
- 85-94: "Excellent, highly recommended" (4.5 stars, A)
- 75-84: "Very good, recommended" (4 stars, B+)
- 68-74: "Good, worth seeing" (3.5 stars, B)
- 60-67: "Decent but flawed" (3 stars, C+)
- 50-59: "Mediocre, mixed feelings" (2.5 stars, C)
- 40-49: "Below average" (2 stars, D+)
- 30-39: "Poor" (1.5 stars, D)
- 0-29: "Terrible" (1 star, F)

Respond with ONLY a JSON object: {"score": N}

REVIEW TEXT:
`;

interface ReviewData {
  showId: string;
  file: string;
  originalScore: string;
  numericScore: number;
  fullText?: string;
  excerpt?: string;
}

function convertToNumeric(originalScore: string | number): number | null {
  if (typeof originalScore === 'number') return originalScore;
  if (!originalScore) return null;

  const s = String(originalScore).toLowerCase().trim();

  // Skip sentiment-only
  if (['positive', 'negative', 'mixed', 'rave', 'pan'].includes(s)) return null;
  if (s.includes('sentiment:')) return null;

  // Letter grades
  const letterGrades: Record<string, number> = {
    'a+': 97, 'a': 93, 'a-': 90,
    'b+': 87, 'b': 83, 'b-': 80,
    'c+': 77, 'c': 73, 'c-': 70,
    'd+': 67, 'd': 63, 'd-': 60,
    'f': 50
  };
  if (letterGrades[s]) return letterGrades[s];

  // Star ratings (X/5 format)
  const starMatch = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)(?:\s*stars?)?/i);
  if (starMatch) {
    return (parseFloat(starMatch[1]) / parseFloat(starMatch[2])) * 100;
  }

  // "X stars" format
  const starsMatch = s.match(/(\d+(?:\.\d+)?)\s*stars?/i);
  if (starsMatch) {
    return (parseFloat(starsMatch[1]) / 5) * 100;
  }

  return null;
}

async function scoreWithOpenAI(client: OpenAI, text: string, maxRetries = 3): Promise<number | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',  // UPDATED: Using GPT-4o (not mini) for production accuracy
        max_tokens: 50,
        temperature: 0.3,
        messages: [{ role: 'user', content: ANCHORED_PROMPT + text.slice(0, 4000) }]
      });

      const content = response.choices[0]?.message?.content || '';
      const match = content.match(/\{[^}]*"score"\s*:\s*(\d+)[^}]*\}/);
      if (match) return parseInt(match[1]);

      const numMatch = content.match(/(\d+)/);
      if (numMatch) return parseInt(numMatch[1]);

      return null;
    } catch (e: any) {
      // Handle rate limiting with retry
      if (e.message?.includes('429') || e.message?.includes('Rate limit')) {
        const waitTime = Math.pow(2, attempt) * 2000;  // 2s, 4s, 8s
        console.log(`Rate limited, waiting ${waitTime/1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      console.error(`OpenAI error: ${e.message}`);
      return null;
    }
  }
  return null;
}

async function scoreWithClaude(client: Anthropic, text: string): Promise<number | null> {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{ role: 'user', content: ANCHORED_PROMPT + text.slice(0, 4000) }]
    });

    const content = response.content[0];
    if (content.type !== 'text') return null;

    const match = content.text.match(/\{[^}]*"score"\s*:\s*(\d+)[^}]*\}/);
    if (match) return parseInt(match[1]);

    const numMatch = content.text.match(/(\d+)/);
    if (numMatch) return parseInt(numMatch[1]);

    return null;
  } catch (e: any) {
    console.error(`Claude error: ${e.message}`);
    return null;
  }
}

async function loadReviewsWithExplicitScores(): Promise<ReviewData[]> {
  const reviewTextsDir = '/Users/tompryor/Broadwayscore/data/review-texts';
  const reviews: ReviewData[] = [];

  const shows = fs.readdirSync(reviewTextsDir).filter(f => {
    return fs.statSync(path.join(reviewTextsDir, f)).isDirectory();
  });

  for (const show of shows) {
    const showDir = path.join(reviewTextsDir, show);
    const files = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (data.originalScore) {
          const numeric = convertToNumeric(data.originalScore);
          if (numeric !== null) {
            const text = data.fullText || data.showScoreExcerpt || data.dtliExcerpt || data.bwwExcerpt;
            if (text && text.length > 50) {
              reviews.push({
                showId: show,
                file,
                originalScore: data.originalScore,
                numericScore: numeric,
                fullText: data.fullText,
                excerpt: data.showScoreExcerpt || data.dtliExcerpt || data.bwwExcerpt
              });
            }
          }
        }
      } catch (e) {}
    }
  }

  return reviews;
}

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!openaiKey || !claudeKey) {
    console.error('Need OPENAI_API_KEY and ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: openaiKey });
  const claude = new Anthropic({ apiKey: claudeKey });

  console.log('Loading reviews with explicit scores...');
  const reviews = await loadReviewsWithExplicitScores();
  console.log(`Found ${reviews.length} reviews with explicit scores and text\n`);

  const results: any[] = [];
  let processed = 0;

  for (const review of reviews) {
    const text = review.fullText || review.excerpt || '';

    // Get scores SEQUENTIALLY to avoid rate limits with GPT-4o
    // (GPT-4o has lower rate limits than 4o-mini)
    const openai1 = await scoreWithOpenAI(openai, text);
    await new Promise(r => setTimeout(r, 1000));  // 1s delay between OpenAI calls
    const openai2 = await scoreWithOpenAI(openai, text);
    await new Promise(r => setTimeout(r, 500));   // Small delay before Claude
    const claudeScore = await scoreWithClaude(claude, text);

    if (openai1 === null || openai2 === null || claudeScore === null) {
      console.log(`⚠️  Skipping ${review.showId}/${review.file} - API failure`);
      continue;
    }

    const openaiAvg = (openai1 + openai2) / 2;
    const openaiClaudeAvg = (openai1 + claudeScore) / 2;

    results.push({
      reviewId: `${review.showId}/${review.file}`,
      expected: review.numericScore,
      originalScore: review.originalScore,
      openai1,
      openai2,
      claudeScore,
      openaiAvg,
      openaiClaudeAvg,
      // Errors
      openai1Error: openai1 - review.numericScore,
      openai2Error: openai2 - review.numericScore,
      openaiAvgError: openaiAvg - review.numericScore,
      openaiClaudeAvgError: openaiClaudeAvg - review.numericScore,
      claudeError: claudeScore - review.numericScore,
      // OpenAI consistency
      openaiDiff: Math.abs(openai1 - openai2)
    });

    processed++;
    if (processed % 25 === 0) {
      console.log(`Processed ${processed}/${reviews.length}...`);

      // Save intermediate results
      fs.writeFileSync(
        '/Users/tompryor/Broadwayscore/data/audit/model-comparison-results.json',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          processed,
          total: reviews.length,
          results
        }, null, 2)
      );
    }

    // Delay to avoid rate limits (GPT-4o has stricter limits than 4o-mini)
    await new Promise(r => setTimeout(r, 2000));
  }

  // Calculate final stats
  const n = results.length;

  const stats = {
    singleOpenAI: {
      mae: results.reduce((s, r) => s + Math.abs(r.openai1Error), 0) / n,
      bias: results.reduce((s, r) => s + r.openai1Error, 0) / n,
      within5: results.filter(r => Math.abs(r.openai1Error) <= 5).length / n * 100,
      within10: results.filter(r => Math.abs(r.openai1Error) <= 10).length / n * 100,
      within15: results.filter(r => Math.abs(r.openai1Error) <= 15).length / n * 100,
    },
    doubleOpenAI: {
      mae: results.reduce((s, r) => s + Math.abs(r.openaiAvgError), 0) / n,
      bias: results.reduce((s, r) => s + r.openaiAvgError, 0) / n,
      within5: results.filter(r => Math.abs(r.openaiAvgError) <= 5).length / n * 100,
      within10: results.filter(r => Math.abs(r.openaiAvgError) <= 10).length / n * 100,
      within15: results.filter(r => Math.abs(r.openaiAvgError) <= 15).length / n * 100,
    },
    openaiPlusClaude: {
      mae: results.reduce((s, r) => s + Math.abs(r.openaiClaudeAvgError), 0) / n,
      bias: results.reduce((s, r) => s + r.openaiClaudeAvgError, 0) / n,
      within5: results.filter(r => Math.abs(r.openaiClaudeAvgError) <= 5).length / n * 100,
      within10: results.filter(r => Math.abs(r.openaiClaudeAvgError) <= 10).length / n * 100,
      within15: results.filter(r => Math.abs(r.openaiClaudeAvgError) <= 15).length / n * 100,
    },
    claudeOnly: {
      mae: results.reduce((s, r) => s + Math.abs(r.claudeError), 0) / n,
      bias: results.reduce((s, r) => s + r.claudeError, 0) / n,
      within5: results.filter(r => Math.abs(r.claudeError) <= 5).length / n * 100,
      within10: results.filter(r => Math.abs(r.claudeError) <= 10).length / n * 100,
      within15: results.filter(r => Math.abs(r.claudeError) <= 15).length / n * 100,
    },
    openaiConsistency: {
      avgDiff: results.reduce((s, r) => s + r.openaiDiff, 0) / n,
      maxDiff: Math.max(...results.map(r => r.openaiDiff)),
      perfectMatch: results.filter(r => r.openaiDiff === 0).length / n * 100,
      within5: results.filter(r => r.openaiDiff <= 5).length / n * 100,
    }
  };

  // Print results
  console.log('\n' + '='.repeat(70));
  console.log('MODEL COMPARISON EXPERIMENT RESULTS');
  console.log('='.repeat(70));
  console.log(`\nSample size: ${n} reviews\n`);

  console.log('--- Accuracy vs Explicit Critic Scores ---\n');
  console.log('| Approach | MAE | Bias | Within 5 | Within 10 | Within 15 |');
  console.log('|----------|-----|------|----------|-----------|-----------|');
  console.log(`| Single OpenAI | ${stats.singleOpenAI.mae.toFixed(1)} | ${stats.singleOpenAI.bias > 0 ? '+' : ''}${stats.singleOpenAI.bias.toFixed(1)} | ${stats.singleOpenAI.within5.toFixed(1)}% | ${stats.singleOpenAI.within10.toFixed(1)}% | ${stats.singleOpenAI.within15.toFixed(1)}% |`);
  console.log(`| 2x OpenAI Avg | ${stats.doubleOpenAI.mae.toFixed(1)} | ${stats.doubleOpenAI.bias > 0 ? '+' : ''}${stats.doubleOpenAI.bias.toFixed(1)} | ${stats.doubleOpenAI.within5.toFixed(1)}% | ${stats.doubleOpenAI.within10.toFixed(1)}% | ${stats.doubleOpenAI.within15.toFixed(1)}% |`);
  console.log(`| OpenAI+Claude | ${stats.openaiPlusClaude.mae.toFixed(1)} | ${stats.openaiPlusClaude.bias > 0 ? '+' : ''}${stats.openaiPlusClaude.bias.toFixed(1)} | ${stats.openaiPlusClaude.within5.toFixed(1)}% | ${stats.openaiPlusClaude.within10.toFixed(1)}% | ${stats.openaiPlusClaude.within15.toFixed(1)}% |`);
  console.log(`| Claude Only | ${stats.claudeOnly.mae.toFixed(1)} | ${stats.claudeOnly.bias > 0 ? '+' : ''}${stats.claudeOnly.bias.toFixed(1)} | ${stats.claudeOnly.within5.toFixed(1)}% | ${stats.claudeOnly.within10.toFixed(1)}% | ${stats.claudeOnly.within15.toFixed(1)}% |`);

  console.log('\n--- OpenAI Consistency (between 2 calls) ---');
  console.log(`Average difference: ${stats.openaiConsistency.avgDiff.toFixed(1)} points`);
  console.log(`Max difference: ${stats.openaiConsistency.maxDiff} points`);
  console.log(`Perfect match (0 diff): ${stats.openaiConsistency.perfectMatch.toFixed(1)}%`);
  console.log(`Within 5 points: ${stats.openaiConsistency.within5.toFixed(1)}%`);

  // Save final results
  const output = {
    timestamp: new Date().toISOString(),
    sampleSize: n,
    stats,
    results
  };

  fs.writeFileSync(
    '/Users/tompryor/Broadwayscore/data/audit/model-comparison-results.json',
    JSON.stringify(output, null, 2)
  );

  console.log('\n✓ Results saved to data/audit/model-comparison-results.json');
}

main().catch(console.error);
