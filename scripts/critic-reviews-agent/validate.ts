#!/usr/bin/env npx ts-node
/**
 * Validation script for critic reviews data
 *
 * Usage:
 *   npx ts-node scripts/critic-reviews-agent/validate.ts bug-2025
 *   npm run reviews:validate -- bug-2025
 */

import * as fs from 'fs';
import * as path from 'path';

const TIER_WEIGHTS: Record<number, number> = { 1: 1.0, 2: 0.85, 3: 0.70 };

const OUTLET_TIERS: Record<string, number> = {
  // Tier 1
  'NYT': 1, 'WASHPOST': 1, 'VARIETY': 1, 'VULT': 1, 'TIMEOUTNY': 1, 'THR': 1, 'GUARDIAN': 1,
  // Tier 2
  'DEADLINE': 2, 'INDIEWIRE': 2, 'NYDN': 2, 'NYP': 2, 'TDB': 2, 'CHTRIB': 2,
  'TMAN': 2, 'NYSR': 2, 'NYTG': 2, 'NYTHTR': 2, 'EW': 2, 'WRAP': 2, 'THLY': 2,
  // Tier 3
  'AMNY': 3, 'CSCE': 3, 'FRONTMEZZ': 3, 'BWW': 3, 'JITNEY': 3, 'STGCNMA': 3, 'CITI': 3, 'OMC': 3,
};

interface Review {
  showId: string;
  outletId?: string;
  outlet: string;
  assignedScore?: number;
  bucket?: string;
  thumb?: string;
  criticName?: string;
  url?: string;
}

function validate(showId: string) {
  const reviewsPath = path.join(__dirname, '../../data/reviews.json');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
  const reviews: Review[] = data.reviews.filter((r: Review) => r.showId === showId && r.assignedScore !== undefined);

  if (reviews.length === 0) {
    console.log(`No reviews found for show: ${showId}`);
    return;
  }

  // Calculate scores
  const scores = reviews.map(r => r.assignedScore!);
  const simpleAvg = scores.reduce((a, b) => a + b, 0) / scores.length;

  let weightedSum = 0;
  let totalWeight = 0;
  const tierCounts: Record<number, { count: number; sum: number }> = { 1: { count: 0, sum: 0 }, 2: { count: 0, sum: 0 }, 3: { count: 0, sum: 0 } };

  reviews.forEach(r => {
    const tier = OUTLET_TIERS[r.outletId || ''] || 3;
    const weight = TIER_WEIGHTS[tier];
    weightedSum += r.assignedScore! * weight;
    totalWeight += weight;
    tierCounts[tier].count++;
    tierCounts[tier].sum += r.assignedScore!;
  });

  const weightedAvg = weightedSum / totalWeight;

  // Count by bucket
  const buckets = { Rave: 0, Positive: 0, Mixed: 0, Pan: 0 };
  reviews.forEach(r => {
    if (r.bucket && buckets.hasOwnProperty(r.bucket)) {
      buckets[r.bucket as keyof typeof buckets]++;
    }
  });

  // Validation checks
  const issues: string[] = [];

  // Check bucket/score consistency
  reviews.forEach(r => {
    const score = r.assignedScore!;
    let expectedBucket: string;
    if (score >= 85) expectedBucket = 'Rave';
    else if (score >= 70) expectedBucket = 'Positive';
    else if (score >= 50) expectedBucket = 'Mixed';
    else expectedBucket = 'Pan';

    if (r.bucket && r.bucket !== expectedBucket) {
      issues.push(`${r.outlet}: score ${score} should be ${expectedBucket}, not ${r.bucket}`);
    }
  });

  // Output
  console.log(`\n=== ${showId.toUpperCase()} VALIDATION ===\n`);
  console.log(`Total Reviews: ${reviews.length}`);
  console.log(`Simple Average: ${simpleAvg.toFixed(1)}`);
  console.log(`Weighted Average: ${weightedAvg.toFixed(1)}`);
  console.log('');
  console.log('Breakdown:');
  console.log(`  Rave (85+):     ${buckets.Rave}`);
  console.log(`  Positive (70-84): ${buckets.Positive}`);
  console.log(`  Mixed (50-69):  ${buckets.Mixed}`);
  console.log(`  Pan (<50):      ${buckets.Pan}`);
  console.log('');
  console.log(`% Positive: ${((buckets.Rave + buckets.Positive) / reviews.length * 100).toFixed(0)}%`);
  console.log('');
  console.log('By Tier:');
  for (const tier of [1, 2, 3]) {
    const t = tierCounts[tier];
    if (t.count > 0) {
      console.log(`  Tier ${tier}: ${t.count} reviews, avg ${(t.sum / t.count).toFixed(1)}`);
    }
  }

  if (issues.length > 0) {
    console.log('\n⚠️  ISSUES FOUND:');
    issues.forEach(i => console.log(`  - ${i}`));
  } else {
    console.log('\n✓ No validation issues');
  }

  // List all reviews
  console.log('\nAll Reviews:');
  const sorted = [...reviews].sort((a, b) => (b.assignedScore || 0) - (a.assignedScore || 0));
  sorted.forEach(r => {
    const tier = OUTLET_TIERS[r.outletId || ''] || 3;
    console.log(`  [T${tier}] ${r.outlet}${r.criticName ? ` (${r.criticName})` : ''}: ${r.assignedScore} (${r.bucket})`);
  });
}

// Run
const showId = process.argv[2];
if (!showId) {
  console.log('Usage: npx ts-node validate.ts <show-id>');
  console.log('Example: npx ts-node validate.ts bug-2025');
  process.exit(1);
}

validate(showId);
