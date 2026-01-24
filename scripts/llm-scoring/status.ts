#!/usr/bin/env npx ts-node --project scripts/tsconfig.json

/**
 * LLM Scoring Status Report
 *
 * Shows the current state of LLM scoring across all reviews:
 * - How many reviews have LLM scores
 * - Distribution of scores and confidence levels
 * - Comparison with human-assigned scores
 *
 * Usage:
 *   npx ts-node scripts/llm-scoring/status.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScoredReviewFile, ReviewEntry } from './types';
import { scoreToBucket } from './config';

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const REVIEWS_JSON_PATH = path.join(__dirname, '../../data/reviews.json');

interface ShowStatus {
  showId: string;
  totalReviews: number;
  withFullText: number;
  withLLMScore: number;
  withHumanScore: number;
  avgLLMScore: number | null;
  avgHumanScore: number | null;
  scoreDelta: number | null;
}

function main(): void {
  console.log('=== LLM Scoring Status Report ===\n');

  // Load reviews.json for human scores
  let humanReviews: ReviewEntry[] = [];
  if (fs.existsSync(REVIEWS_JSON_PATH)) {
    const data = JSON.parse(fs.readFileSync(REVIEWS_JSON_PATH, 'utf-8'));
    humanReviews = data.reviews || [];
  }

  // Index human reviews by show+outlet
  const humanScoreMap = new Map<string, number>();
  for (const r of humanReviews) {
    const key = `${r.showId}::${r.outlet}`;
    humanScoreMap.set(key, r.assignedScore);
  }

  // Analyze review-texts directory
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.log('No review-texts directory found.');
    return;
  }

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f =>
    fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory()
  );

  // Collect all data
  let totalReviews = 0;
  let withFullText = 0;
  let withLLMScore = 0;
  let withHumanScore = 0;

  const allLLMScores: number[] = [];
  const allHumanScores: number[] = [];
  const showStatuses: ShowStatus[] = [];

  const confidenceDistribution = { high: 0, medium: 0, low: 0 };
  const bucketDistribution: Record<string, number> = {
    Rave: 0,
    Positive: 0,
    Mixed: 0,
    Negative: 0,
    Pan: 0
  };

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    let showTotal = 0;
    let showWithText = 0;
    let showWithLLM = 0;
    let showWithHuman = 0;
    const showLLMScores: number[] = [];
    const showHumanScores: number[] = [];

    for (const file of files) {
      try {
        const content = JSON.parse(
          fs.readFileSync(path.join(showDir, file), 'utf-8')
        ) as Partial<ScoredReviewFile>;

        showTotal++;
        totalReviews++;

        // Has full text?
        if (content.fullText && content.fullText.length >= 50) {
          showWithText++;
          withFullText++;
        }

        // Has LLM score?
        if (content.llmScore && typeof content.llmScore.score === 'number') {
          showWithLLM++;
          withLLMScore++;
          allLLMScores.push(content.llmScore.score);
          showLLMScores.push(content.llmScore.score);

          // Track confidence
          const conf = content.llmScore.confidence || 'medium';
          confidenceDistribution[conf]++;

          // Track bucket
          const bucket = content.llmScore.bucket || scoreToBucket(content.llmScore.score);
          bucketDistribution[bucket] = (bucketDistribution[bucket] || 0) + 1;
        }

        // Has human score?
        const humanKey = `${content.showId}::${content.outlet}`;
        const humanScore = humanScoreMap.get(humanKey);
        if (humanScore !== undefined) {
          showWithHuman++;
          withHumanScore++;
          allHumanScores.push(humanScore);
          showHumanScores.push(humanScore);
        }
      } catch {
        // Skip malformed files
      }
    }

    const avgLLM = showLLMScores.length > 0
      ? showLLMScores.reduce((a, b) => a + b, 0) / showLLMScores.length
      : null;

    const avgHuman = showHumanScores.length > 0
      ? showHumanScores.reduce((a, b) => a + b, 0) / showHumanScores.length
      : null;

    showStatuses.push({
      showId: show,
      totalReviews: showTotal,
      withFullText: showWithText,
      withLLMScore: showWithLLM,
      withHumanScore: showWithHuman,
      avgLLMScore: avgLLM ? Math.round(avgLLM * 10) / 10 : null,
      avgHumanScore: avgHuman ? Math.round(avgHuman * 10) / 10 : null,
      scoreDelta: avgLLM && avgHuman ? Math.round((avgLLM - avgHuman) * 10) / 10 : null
    });
  }

  // Overall statistics
  console.log('--- Overall Statistics ---\n');
  console.log(`Total shows: ${shows.length}`);
  console.log(`Total review files: ${totalReviews}`);
  console.log(`With full text (>= 50 chars): ${withFullText} (${((withFullText / totalReviews) * 100).toFixed(1)}%)`);
  console.log(`With LLM score: ${withLLMScore} (${((withLLMScore / totalReviews) * 100).toFixed(1)}%)`);
  console.log(`With human score: ${withHumanScore} (${((withHumanScore / totalReviews) * 100).toFixed(1)}%)`);
  console.log(`Remaining to score: ${withFullText - withLLMScore}`);

  if (allLLMScores.length > 0) {
    const avgLLM = allLLMScores.reduce((a, b) => a + b, 0) / allLLMScores.length;
    const minLLM = Math.min(...allLLMScores);
    const maxLLM = Math.max(...allLLMScores);

    console.log('\n--- LLM Score Distribution ---\n');
    console.log(`Average: ${avgLLM.toFixed(1)}`);
    console.log(`Range: ${minLLM} - ${maxLLM}`);

    console.log('\nBy bucket:');
    for (const [bucket, count] of Object.entries(bucketDistribution)) {
      if (count > 0) {
        console.log(`  ${bucket}: ${count} (${((count / withLLMScore) * 100).toFixed(1)}%)`);
      }
    }

    console.log('\nBy confidence:');
    for (const [level, count] of Object.entries(confidenceDistribution)) {
      if (count > 0) {
        console.log(`  ${level}: ${count} (${((count / withLLMScore) * 100).toFixed(1)}%)`);
      }
    }
  }

  // Per-show breakdown
  console.log('\n--- Per-Show Breakdown ---\n');
  console.log('Show                         | Total | Text | LLM | Human | Δ');
  console.log('-'.repeat(70));

  // Sort by LLM coverage (descending)
  showStatuses.sort((a, b) => (b.withLLMScore / b.withFullText || 0) - (a.withLLMScore / a.withFullText || 0));

  for (const s of showStatuses) {
    const name = s.showId.padEnd(28);
    const total = String(s.totalReviews).padStart(5);
    const text = String(s.withFullText).padStart(4);
    const llm = String(s.withLLMScore).padStart(3);
    const human = String(s.withHumanScore).padStart(5);
    const delta = s.scoreDelta !== null
      ? (s.scoreDelta >= 0 ? '+' : '') + s.scoreDelta.toFixed(1)
      : 'N/A';

    console.log(`${name} | ${total} | ${text} | ${llm} | ${human} | ${delta.padStart(5)}`);
  }

  // Shows needing scoring
  const needsScoring = showStatuses.filter(s => s.withFullText > s.withLLMScore);
  if (needsScoring.length > 0) {
    console.log('\n--- Shows Needing Scoring ---\n');
    for (const s of needsScoring) {
      const remaining = s.withFullText - s.withLLMScore;
      console.log(`  ${s.showId}: ${remaining} reviews to score`);
    }
  }
}

main();
