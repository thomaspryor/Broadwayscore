#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Test Different Prompt Variations
 *
 * Tests 4 different prompting strategies on the same reviews to find the most accurate approach.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

// ========================================
// PROMPT VARIANTS
// ========================================

const PROMPTS = {
  baseline: {
    name: 'Baseline (Current)',
    system: `You are a theater critic scoring system. Score Broadway reviews on a 0-100 scale.

Buckets:
- Rave (85-100): Enthusiastic, unreserved praise
- Positive (68-84): Generally favorable with minor reservations
- Mixed (50-67): Balanced pros and cons
- Negative (30-49): More negative than positive
- Pan (0-29): Strongly negative

Respond with JSON only: {"bucket": "...", "score": N}`,
  },

  anchored: {
    name: 'Anchored (Reference Points)',
    system: `You are a theater critic scoring system. Match your scores to how professional aggregators would rate this review.

CALIBRATION ANCHORS:
- 95-100: "Masterpiece, must-see" (★★★★★, A+)
- 85-94: "Excellent, highly recommended" (★★★★, A)
- 75-84: "Very good, recommended" (★★★½, B+)
- 68-74: "Good, worth seeing" (★★★, B)
- 60-67: "Decent but flawed" (★★½, C+)
- 50-59: "Mediocre, mixed feelings" (★★, C)
- 40-49: "Below average" (★½, D+)
- 30-39: "Poor" (★, D)
- 0-29: "Terrible" (no stars, F)

Respond with JSON only: {"bucket": "Rave|Positive|Mixed|Negative|Pan", "score": N}`,
  },

  quote_focused: {
    name: 'Quote-Focused',
    system: `You are a theater review analyzer. Your job is to:

1. Find the STRONGEST positive statement in the review
2. Find the STRONGEST negative statement (if any)
3. Weigh them to determine overall sentiment

Scoring guide:
- If positives strongly outweigh negatives: Rave (85-100) or Positive (68-84)
- If roughly balanced: Mixed (50-67)
- If negatives outweigh: Negative (30-49) or Pan (0-29)

Respond with JSON only: {"bucket": "...", "score": N, "positive_quote": "...", "negative_quote": "..."}`,
  },

  recommendation_focused: {
    name: 'Recommendation-Focused',
    system: `You are evaluating whether a theater critic recommends seeing a show.

Ask yourself: Would the critic tell a friend to buy a ticket?

- "Absolutely, don't miss it!" → Rave (85-100)
- "Yes, it's worth seeing" → Positive (68-84)
- "Maybe, depends on your taste" → Mixed (50-67)
- "Probably not" → Negative (30-49)
- "Definitely not, avoid" → Pan (0-29)

Respond with JSON only: {"bucket": "...", "score": N}`,
  }
};

interface ReviewData {
  id: string;
  text: string;
  originalScore: number | null;
  dtliThumb: string | null;
}

function findTestReviews(count: number): ReviewData[] {
  const reviewsDir = 'data/review-texts';
  const reviews: ReviewData[] = [];

  // Prioritize reviews with both originalScore and dtliThumb for validation
  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  for (const show of shows) {
    if (reviews.length >= count) break;

    const files = fs.readdirSync(path.join(reviewsDir, show))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      if (reviews.length >= count) break;

      try {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, show, file), 'utf8'));

        // Require full text
        if (!data.fullText || data.fullText.length < 300) continue;

        // Prefer reviews with ground truth
        const hasGroundTruth = data.originalScore !== null || data.dtliThumb;
        if (!hasGroundTruth && reviews.length < count * 0.5) continue; // First half should have ground truth

        reviews.push({
          id: `${show}/${data.outlet}`,
          text: data.fullText.substring(0, 2500),
          originalScore: data.originalScore,
          dtliThumb: data.dtliThumb || null
        });
      } catch (e) { }
    }
  }

  return reviews;
}

function normalizeThumb(thumb: string | null): string | null {
  if (!thumb) return null;
  const t = thumb.toLowerCase();
  if (t === 'up') return 'Up';
  if (t === 'down') return 'Down';
  if (t === 'meh' || t === 'mixed') return 'Meh';
  return null;
}

function bucketToThumb(bucket: string): string {
  if (bucket === 'Rave' || bucket === 'Positive') return 'Up';
  if (bucket === 'Mixed') return 'Meh';
  return 'Down';
}

async function scoreWithClaude(
  client: Anthropic,
  systemPrompt: string,
  reviewText: string
): Promise<{ bucket: string; score: number } | null> {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Score this review:\n\n${reviewText}` }]
    });

    const content = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      return { bucket: parsed.bucket, score: parsed.score };
    } catch {
      const scoreMatch = content.match(/"score"\s*:\s*(\d+)/);
      const bucketMatch = content.match(/"bucket"\s*:\s*"(\w+)"/);
      if (scoreMatch && bucketMatch) {
        return { score: parseInt(scoreMatch[1]), bucket: bucketMatch[1] };
      }
    }
  } catch (e) { }
  return null;
}

async function scoreWithOpenAI(
  client: OpenAI,
  systemPrompt: string,
  reviewText: string
): Promise<{ bucket: string; score: number } | null> {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Score this review:\n\n${reviewText}` }
      ]
    });

    const content = response.choices[0].message.content || '';
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      return { bucket: parsed.bucket, score: parsed.score };
    } catch {
      const scoreMatch = content.match(/"score"\s*:\s*(\d+)/);
      const bucketMatch = content.match(/"bucket"\s*:\s*"(\w+)"/);
      if (scoreMatch && bucketMatch) {
        return { score: parseInt(scoreMatch[1]), bucket: bucketMatch[1] };
      }
    }
  } catch (e) { }
  return null;
}

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!claudeKey || !openaiKey) {
    console.error('Need ANTHROPIC_API_KEY and OPENAI_API_KEY');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: claudeKey });
  const openai = new OpenAI({ apiKey: openaiKey });

  console.log('='.repeat(60));
  console.log('PROMPT VARIATION EXPERIMENT');
  console.log('='.repeat(60));

  const reviews = findTestReviews(30); // Test on 30 reviews
  console.log(`\nTesting ${Object.keys(PROMPTS).length} prompt variants on ${reviews.length} reviews\n`);

  const results: Record<string, {
    claude: { mae: number; thumbAccuracy: number; scores: number[] };
    openai: { mae: number; thumbAccuracy: number; scores: number[] };
  }> = {};

  for (const [promptKey, prompt] of Object.entries(PROMPTS)) {
    console.log(`\n--- Testing: ${prompt.name} ---\n`);

    const claudeResults: { score: number; original: number | null; dtliThumb: string | null }[] = [];
    const openaiResults: { score: number; original: number | null; dtliThumb: string | null }[] = [];

    for (let i = 0; i < reviews.length; i++) {
      const review = reviews[i];
      process.stdout.write(`\r[${i + 1}/${reviews.length}] ${review.id.substring(0, 40)}...`);

      // Score with both models
      const [claudeScore, openaiScore] = await Promise.all([
        scoreWithClaude(claude, prompt.system, review.text),
        scoreWithOpenAI(openai, prompt.system, review.text)
      ]);

      if (claudeScore) {
        claudeResults.push({
          score: claudeScore.score,
          original: review.originalScore,
          dtliThumb: review.dtliThumb
        });
      }

      if (openaiScore) {
        openaiResults.push({
          score: openaiScore.score,
          original: review.originalScore,
          dtliThumb: review.dtliThumb
        });
      }

      await new Promise(r => setTimeout(r, 300)); // Rate limit
    }

    console.log('\n');

    // Calculate metrics for Claude
    const claudeWithOriginal = claudeResults.filter(r => r.original !== null);
    const claudeMAE = claudeWithOriginal.length > 0
      ? claudeWithOriginal.reduce((sum, r) => sum + Math.abs(r.score - r.original!), 0) / claudeWithOriginal.length
      : 0;

    const claudeWithThumb = claudeResults.filter(r => r.dtliThumb !== null);
    const claudeThumbCorrect = claudeWithThumb.filter(r => {
      const bucket = r.score >= 85 ? 'Rave' : r.score >= 68 ? 'Positive' : r.score >= 50 ? 'Mixed' : r.score >= 30 ? 'Negative' : 'Pan';
      return bucketToThumb(bucket) === normalizeThumb(r.dtliThumb);
    }).length;
    const claudeThumbAcc = claudeWithThumb.length > 0 ? (claudeThumbCorrect / claudeWithThumb.length) * 100 : 0;

    // Calculate metrics for OpenAI
    const openaiWithOriginal = openaiResults.filter(r => r.original !== null);
    const openaiMAE = openaiWithOriginal.length > 0
      ? openaiWithOriginal.reduce((sum, r) => sum + Math.abs(r.score - r.original!), 0) / openaiWithOriginal.length
      : 0;

    const openaiWithThumb = openaiResults.filter(r => r.dtliThumb !== null);
    const openaiThumbCorrect = openaiWithThumb.filter(r => {
      const bucket = r.score >= 85 ? 'Rave' : r.score >= 68 ? 'Positive' : r.score >= 50 ? 'Mixed' : r.score >= 30 ? 'Negative' : 'Pan';
      return bucketToThumb(bucket) === normalizeThumb(r.dtliThumb);
    }).length;
    const openaiThumbAcc = openaiWithThumb.length > 0 ? (openaiThumbCorrect / openaiWithThumb.length) * 100 : 0;

    results[promptKey] = {
      claude: {
        mae: claudeMAE,
        thumbAccuracy: claudeThumbAcc,
        scores: claudeResults.map(r => r.score)
      },
      openai: {
        mae: openaiMAE,
        thumbAccuracy: openaiThumbAcc,
        scores: openaiResults.map(r => r.score)
      }
    };

    console.log(`Claude: MAE=${claudeMAE.toFixed(1)}, Thumb Accuracy=${claudeThumbAcc.toFixed(1)}%`);
    console.log(`OpenAI: MAE=${openaiMAE.toFixed(1)}, Thumb Accuracy=${openaiThumbAcc.toFixed(1)}%`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('PROMPT COMPARISON SUMMARY');
  console.log('='.repeat(60) + '\n');

  console.log('Claude Results by Prompt:');
  console.log('-'.repeat(50));
  for (const [key, data] of Object.entries(results)) {
    const prompt = PROMPTS[key as keyof typeof PROMPTS];
    console.log(`${prompt.name}:`);
    console.log(`  MAE: ${data.claude.mae.toFixed(1)} | Thumb Acc: ${data.claude.thumbAccuracy.toFixed(1)}%`);
  }

  console.log('\nOpenAI Results by Prompt:');
  console.log('-'.repeat(50));
  for (const [key, data] of Object.entries(results)) {
    const prompt = PROMPTS[key as keyof typeof PROMPTS];
    console.log(`${prompt.name}:`);
    console.log(`  MAE: ${data.openai.mae.toFixed(1)} | Thumb Acc: ${data.openai.thumbAccuracy.toFixed(1)}%`);
  }

  // Save results
  const outputPath = 'data/audit/prompt-variation-results.json';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    reviewCount: reviews.length,
    prompts: PROMPTS,
    results
  }, null, 2));

  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(console.error);
