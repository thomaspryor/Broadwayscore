#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Test model self-consistency by scoring the same reviews twice
 *
 * Run: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
 *      npx ts-node scripts/llm-scoring/test-consistency.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReviewScorer } from './scorer';
import { OpenAIReviewScorer } from './openai-scorer';
import { GeminiScorer } from './gemini-scorer';

interface TestReview {
  id: string;
  text: string;
  dtliThumb: string | null;
}

// Find reviews with full text
function findTestReviews(count: number): TestReview[] {
  const reviewsDir = 'data/review-texts';
  const reviews: TestReview[] = [];

  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  outer:
  for (const show of shows) {
    const files = fs.readdirSync(path.join(reviewsDir, show))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, show, file), 'utf8'));
        if (data.fullText && data.fullText.length > 500) {
          reviews.push({
            id: `${show}/${data.outlet}`,
            text: data.fullText.substring(0, 2000),
            dtliThumb: data.dtliThumb || null
          });
          if (reviews.length >= count) break outer;
        }
      } catch(e) {}
    }
  }

  return reviews;
}

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!claudeKey || !openaiKey) {
    console.error('Need ANTHROPIC_API_KEY and OPENAI_API_KEY');
    process.exit(1);
  }

  const claudeScorer = new ReviewScorer(claudeKey, { model: 'claude-sonnet-4-20250514', verbose: false });
  const openaiScorer = new OpenAIReviewScorer(openaiKey, { model: 'gpt-4o', verbose: false });
  const geminiScorer = geminiKey ? new GeminiScorer(geminiKey, { model: 'gemini-2.0-flash', verbose: false }) : null;

  const testReviews = findTestReviews(5);
  console.log(`Found ${testReviews.length} test reviews\n`);

  console.log('=== SELF-CONSISTENCY TEST ===');
  console.log('Scoring each review TWICE with each model\n');

  const results = {
    claude: { diffs: [] as number[], bucketMatches: 0, total: 0 },
    openai: { diffs: [] as number[], bucketMatches: 0, total: 0 },
    gemini: { diffs: [] as number[], bucketMatches: 0, total: 0 }
  };

  for (let i = 0; i < testReviews.length; i++) {
    const review = testReviews[i];
    console.log(`--- Review ${i+1}: ${review.id} ---`);
    if (review.dtliThumb) console.log(`DTLI thumb: ${review.dtliThumb}`);

    // Claude twice
    try {
      const c1 = await claudeScorer.scoreReviewV5(review.text, '');
      await new Promise(r => setTimeout(r, 500));
      const c2 = await claudeScorer.scoreReviewV5(review.text, '');

      if (c1.success && c2.success && c1.result && c2.result) {
        const diff = Math.abs(c1.result.score - c2.result.score);
        results.claude.diffs.push(diff);
        results.claude.total++;
        if (c1.result.bucket === c2.result.bucket) results.claude.bucketMatches++;
        console.log(`Claude:  Run1=${c1.result.bucket}(${c1.result.score})  Run2=${c2.result.bucket}(${c2.result.score})  Δ=${diff}`);
      }
    } catch(e: any) {
      console.log(`Claude error: ${e.message}`);
    }

    // OpenAI twice
    try {
      const o1 = await openaiScorer.scoreReviewV5(review.text, '');
      await new Promise(r => setTimeout(r, 500));
      const o2 = await openaiScorer.scoreReviewV5(review.text, '');

      if (o1.success && o2.success && o1.result && o2.result) {
        const diff = Math.abs(o1.result.score - o2.result.score);
        results.openai.diffs.push(diff);
        results.openai.total++;
        if (o1.result.bucket === o2.result.bucket) results.openai.bucketMatches++;
        console.log(`OpenAI:  Run1=${o1.result.bucket}(${o1.result.score})  Run2=${o2.result.bucket}(${o2.result.score})  Δ=${diff}`);
      }
    } catch(e: any) {
      console.log(`OpenAI error: ${e.message}`);
    }

    // Gemini twice
    if (geminiScorer) {
      try {
        const g1 = await geminiScorer.scoreReview(review.text, '');
        await new Promise(r => setTimeout(r, 500));
        const g2 = await geminiScorer.scoreReview(review.text, '');

        if (g1.success && g2.success && g1.result && g2.result) {
          const diff = Math.abs(g1.result.score - g2.result.score);
          results.gemini.diffs.push(diff);
          results.gemini.total++;
          if (g1.result.bucket === g2.result.bucket) results.gemini.bucketMatches++;
          console.log(`Gemini:  Run1=${g1.result.bucket}(${g1.result.score})  Run2=${g2.result.bucket}(${g2.result.score})  Δ=${diff}`);
        }
      } catch(e: any) {
        console.log(`Gemini error: ${e.message}`);
      }
    }

    console.log('');
  }

  console.log('=== CONSISTENCY SUMMARY ===\n');

  for (const model of ['claude', 'openai', 'gemini'] as const) {
    const r = results[model];
    if (r.total === 0) continue;

    const avgDiff = (r.diffs.reduce((a,b) => a+b, 0) / r.diffs.length).toFixed(1);
    const maxDiff = Math.max(...r.diffs);
    const bucketConsistency = ((r.bucketMatches / r.total) * 100).toFixed(0);

    console.log(`${model.toUpperCase()}:`);
    console.log(`  Avg score difference between runs: ${avgDiff} points`);
    console.log(`  Max score difference: ${maxDiff} points`);
    console.log(`  Bucket consistency: ${r.bucketMatches}/${r.total} (${bucketConsistency}%)`);
    console.log('');
  }
}

main().catch(console.error);
