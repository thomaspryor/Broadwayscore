/**
 * Validation Module
 *
 * Compares our LLM-scored reviews against aggregator thumbs data:
 * - DidTheyLikeIt (DTLI)
 * - BroadwayWorld (BWW)
 * - Show-Score
 *
 * Flags shows where our distribution significantly differs from aggregators.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ThumbsDistribution, AggregatorValidation, ReviewEntry, ScoredReviewFile } from './types';
import { scoreToThumb } from './config';

// ========================================
// DATA LOADING
// ========================================

/**
 * Load reviews from reviews.json
 */
function loadReviews(): ReviewEntry[] {
  const reviewsPath = path.join(__dirname, '../../data/reviews.json');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
  return data.reviews || [];
}

/**
 * Load LLM-scored reviews from review-texts directory
 */
function loadLLMScoredReviews(): ScoredReviewFile[] {
  const reviewTextsDir = path.join(__dirname, '../../data/review-texts');
  const scored: ScoredReviewFile[] = [];

  if (!fs.existsSync(reviewTextsDir)) {
    return scored;
  }

  const shows = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const show of shows) {
    const showDir = path.join(reviewTextsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));
        if (content.llmScore && typeof content.llmScore.score === 'number') {
          scored.push(content as ScoredReviewFile);
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  return scored;
}

// ========================================
// THUMBS CALCULATION
// ========================================

/**
 * Calculate thumbs distribution from LLM scores
 */
function calculateLLMThumbsDistribution(
  reviews: ScoredReviewFile[],
  showId: string
): ThumbsDistribution {
  const showReviews = reviews.filter(r =>
    r.showId === showId || r.showId.replace(/-\d{4}$/, '') === showId.replace(/-\d{4}$/, '')
  );

  const distribution: ThumbsDistribution = { up: 0, flat: 0, down: 0, total: 0 };

  for (const review of showReviews) {
    const thumb = review.llmScore.thumb || scoreToThumb(review.llmScore.score);
    distribution.total++;

    switch (thumb) {
      case 'Up':
        distribution.up++;
        break;
      case 'Flat':
        distribution.flat++;
        break;
      case 'Down':
        distribution.down++;
        break;
    }
  }

  return distribution;
}

/**
 * Extract aggregator thumbs from reviews.json
 * (DTLI and BWW thumbs are stored on individual reviews)
 */
function extractAggregatorThumbs(
  reviews: ReviewEntry[],
  showId: string
): { dtli: ThumbsDistribution | null; bww: ThumbsDistribution | null } {
  const showReviews = reviews.filter(r =>
    r.showId === showId || r.showId.replace(/-\d{4}$/, '') === showId.replace(/-\d{4}$/, '')
  );

  const dtli: ThumbsDistribution = { up: 0, flat: 0, down: 0, total: 0 };
  const bww: ThumbsDistribution = { up: 0, flat: 0, down: 0, total: 0 };

  for (const review of showReviews) {
    // DTLI thumbs
    if (review.dtliThumb) {
      dtli.total++;
      const thumb = review.dtliThumb.toLowerCase();
      if (thumb === 'up' || thumb === 'thumbs up') dtli.up++;
      else if (thumb === 'flat' || thumb === 'sideways') dtli.flat++;
      else if (thumb === 'down' || thumb === 'thumbs down') dtli.down++;
    }

    // BWW thumbs
    if (review.bwwThumb) {
      bww.total++;
      const thumb = review.bwwThumb.toLowerCase();
      if (thumb === 'up' || thumb === 'thumbs up') bww.up++;
      else if (thumb === 'flat' || thumb === 'sideways') bww.flat++;
      else if (thumb === 'down' || thumb === 'thumbs down') bww.down++;
    }
  }

  return {
    dtli: dtli.total > 0 ? dtli : null,
    bww: bww.total > 0 ? bww : null
  };
}

// ========================================
// DISAGREEMENT DETECTION
// ========================================

/**
 * Convert distribution to percentages
 */
function toPercentages(dist: ThumbsDistribution): { up: number; flat: number; down: number } {
  if (dist.total === 0) {
    return { up: 0, flat: 0, down: 0 };
  }
  return {
    up: (dist.up / dist.total) * 100,
    flat: (dist.flat / dist.total) * 100,
    down: (dist.down / dist.total) * 100
  };
}

/**
 * Detect significant disagreement between two distributions
 */
function detectDisagreement(
  ours: ThumbsDistribution,
  theirs: ThumbsDistribution
): { hasDisagreement: boolean; details?: string } {
  if (ours.total < 3 || theirs.total < 3) {
    // Not enough data to compare
    return { hasDisagreement: false };
  }

  const ourPct = toPercentages(ours);
  const theirPct = toPercentages(theirs);

  // Check for major disagreement (>25% difference in any category)
  const upDiff = Math.abs(ourPct.up - theirPct.up);
  const flatDiff = Math.abs(ourPct.flat - theirPct.flat);
  const downDiff = Math.abs(ourPct.down - theirPct.down);

  const maxDiff = Math.max(upDiff, flatDiff, downDiff);

  if (maxDiff > 25) {
    let category = 'Up';
    if (flatDiff === maxDiff) category = 'Flat';
    if (downDiff === maxDiff) category = 'Down';

    const ourValue = category === 'Up' ? ourPct.up : category === 'Flat' ? ourPct.flat : ourPct.down;
    const theirValue = category === 'Up' ? theirPct.up : category === 'Flat' ? theirPct.flat : theirPct.down;

    return {
      hasDisagreement: true,
      details: `${category} thumbs differ by ${maxDiff.toFixed(0)}% (ours: ${ourValue.toFixed(0)}%, theirs: ${theirValue.toFixed(0)}%)`
    };
  }

  // Check for sentiment flip (we say positive, they say negative, or vice versa)
  const ourSentiment = ourPct.up > ourPct.down ? 'positive' : ourPct.down > ourPct.up ? 'negative' : 'mixed';
  const theirSentiment = theirPct.up > theirPct.down ? 'positive' : theirPct.down > theirPct.up ? 'negative' : 'mixed';

  if (
    (ourSentiment === 'positive' && theirSentiment === 'negative') ||
    (ourSentiment === 'negative' && theirSentiment === 'positive')
  ) {
    return {
      hasDisagreement: true,
      details: `Sentiment flip: we say ${ourSentiment}, they say ${theirSentiment}`
    };
  }

  return { hasDisagreement: false };
}

// ========================================
// MAIN VALIDATION
// ========================================

/**
 * Run validation for all shows with LLM scores
 */
export function runValidation(verbose: boolean = false): AggregatorValidation[] {
  if (verbose) {
    console.log('\n=== Aggregator Validation ===\n');
  }

  const reviews = loadReviews();
  const llmReviews = loadLLMScoredReviews();

  // Get unique show IDs from LLM reviews
  const showIds = [...new Set(llmReviews.map(r => r.showId))];

  if (verbose) {
    console.log(`Shows with LLM scores: ${showIds.length}`);
  }

  const validations: AggregatorValidation[] = [];

  for (const showId of showIds) {
    const ourDist = calculateLLMThumbsDistribution(llmReviews, showId);
    const { dtli, bww } = extractAggregatorThumbs(reviews, showId);

    let hasDisagreement = false;
    let disagreementDetails: string | undefined;

    // Compare against DTLI
    if (dtli && dtli.total >= 3) {
      const dtliCheck = detectDisagreement(ourDist, dtli);
      if (dtliCheck.hasDisagreement) {
        hasDisagreement = true;
        disagreementDetails = `DTLI: ${dtliCheck.details}`;
      }
    }

    // Compare against BWW
    if (bww && bww.total >= 3 && !hasDisagreement) {
      const bwwCheck = detectDisagreement(ourDist, bww);
      if (bwwCheck.hasDisagreement) {
        hasDisagreement = true;
        disagreementDetails = `BWW: ${bwwCheck.details}`;
      }
    }

    validations.push({
      showId,
      ourDistribution: ourDist,
      dtliDistribution: dtli || undefined,
      bwwDistribution: bww || undefined,
      hasDisagreement,
      disagreementDetails
    });
  }

  if (verbose) {
    printValidationReport(validations);
  }

  return validations;
}

/**
 * Print validation report
 */
export function printValidationReport(validations: AggregatorValidation[]): void {
  console.log('\n--- Validation Report ---\n');

  const disagreements = validations.filter(v => v.hasDisagreement);
  const agreeing = validations.filter(v => !v.hasDisagreement);

  console.log(`Total shows validated: ${validations.length}`);
  console.log(`Shows with disagreement: ${disagreements.length}`);
  console.log(`Shows in agreement: ${agreeing.length}`);

  if (disagreements.length > 0) {
    console.log('\n--- Shows with Disagreement ---\n');
    for (const v of disagreements) {
      console.log(`${v.showId}:`);
      console.log(`  Our distribution: ${formatDistribution(v.ourDistribution)}`);
      if (v.dtliDistribution) {
        console.log(`  DTLI distribution: ${formatDistribution(v.dtliDistribution)}`);
      }
      if (v.bwwDistribution) {
        console.log(`  BWW distribution: ${formatDistribution(v.bwwDistribution)}`);
      }
      console.log(`  Issue: ${v.disagreementDetails}`);
      console.log('');
    }
  }

  // Summary of agreeing shows
  if (agreeing.length > 0) {
    console.log('\n--- Shows in Agreement ---\n');
    for (const v of agreeing.slice(0, 10)) {
      console.log(`  ${v.showId}: ${formatDistribution(v.ourDistribution)}`);
    }
    if (agreeing.length > 10) {
      console.log(`  ... and ${agreeing.length - 10} more`);
    }
  }
}

/**
 * Format distribution for display
 */
function formatDistribution(dist: ThumbsDistribution): string {
  if (dist.total === 0) {
    return 'No data';
  }
  const pct = toPercentages(dist);
  return `👍 ${dist.up} (${pct.up.toFixed(0)}%) | 👋 ${dist.flat} (${pct.flat.toFixed(0)}%) | 👎 ${dist.down} (${pct.down.toFixed(0)}%)`;
}

/**
 * Validate a single show
 */
export function validateShow(showId: string): AggregatorValidation | null {
  const reviews = loadReviews();
  const llmReviews = loadLLMScoredReviews();

  const showLLMReviews = llmReviews.filter(r => r.showId === showId);
  if (showLLMReviews.length === 0) {
    return null;
  }

  const ourDist = calculateLLMThumbsDistribution(llmReviews, showId);
  const { dtli, bww } = extractAggregatorThumbs(reviews, showId);

  let hasDisagreement = false;
  let disagreementDetails: string | undefined;

  if (dtli && dtli.total >= 3) {
    const dtliCheck = detectDisagreement(ourDist, dtli);
    if (dtliCheck.hasDisagreement) {
      hasDisagreement = true;
      disagreementDetails = `DTLI: ${dtliCheck.details}`;
    }
  }

  if (bww && bww.total >= 3 && !hasDisagreement) {
    const bwwCheck = detectDisagreement(ourDist, bww);
    if (bwwCheck.hasDisagreement) {
      hasDisagreement = true;
      disagreementDetails = `BWW: ${bwwCheck.details}`;
    }
  }

  return {
    showId,
    ourDistribution: ourDist,
    dtliDistribution: dtli || undefined,
    bwwDistribution: bww || undefined,
    hasDisagreement,
    disagreementDetails
  };
}
