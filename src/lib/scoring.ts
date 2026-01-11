// Scoring utilities for Broadway Metascore
// These functions implement the transparent methodology

import {
  CriticReview,
  CriticScore,
  AudiencePlatform,
  AudienceScore,
  BuzzThread,
  BuzzScore,
  Metascore,
  MetascoreWeights,
  Confidence,
  ConfidenceLevel,
  OutletTier,
  DEFAULT_WEIGHTS,
} from '@/types/show';

// ============================================
// RATING NORMALIZATION (0-100 scale)
// ============================================

// Letter grade mappings (documented in methodology)
const LETTER_GRADE_MAP: Record<string, number> = {
  'A+': 98,
  'A': 95,
  'A-': 92,
  'B+': 88,
  'B': 85,
  'B-': 82,
  'C+': 78,
  'C': 75,
  'C-': 72,
  'D+': 68,
  'D': 65,
  'D-': 62,
  'F': 50,
};

// Sentiment-based mappings (for reviews without explicit ratings)
const SENTIMENT_MAP: Record<string, number> = {
  'rave': 95,
  'positive': 80,
  'mixed-positive': 65,
  'mixed': 55,
  'mixed-negative': 45,
  'negative': 30,
  'pan': 15,
};

/**
 * Normalize any rating format to 0-100 scale
 */
export function normalizeRating(rating: string): { score: number; isInferred: boolean } {
  const normalized = rating.trim().toLowerCase();

  // Check for star ratings (e.g., "4/5", "3.5/5", "4 stars", "★★★★")
  const starMatch = normalized.match(/^(\d+\.?\d*)\s*(?:\/|out of)\s*(\d+)/);
  if (starMatch) {
    const [, value, max] = starMatch;
    return { score: Math.round((parseFloat(value) / parseFloat(max)) * 100), isInferred: false };
  }

  // Check for star symbols
  const starSymbols = (normalized.match(/★/g) || []).length;
  const emptyStars = (normalized.match(/☆/g) || []).length;
  if (starSymbols > 0) {
    const totalStars = starSymbols + emptyStars || 5; // Assume 5-star scale
    return { score: Math.round((starSymbols / totalStars) * 100), isInferred: false };
  }

  // Check for letter grades
  const upperRating = rating.trim().toUpperCase();
  if (LETTER_GRADE_MAP[upperRating] !== undefined) {
    return { score: LETTER_GRADE_MAP[upperRating], isInferred: false };
  }

  // Check for percentage
  const percentMatch = normalized.match(/^(\d+)\s*%?$/);
  if (percentMatch) {
    return { score: Math.min(100, parseInt(percentMatch[1])), isInferred: false };
  }

  // Check for sentiment keywords
  for (const [sentiment, score] of Object.entries(SENTIMENT_MAP)) {
    if (normalized.includes(sentiment)) {
      return { score, isInferred: true };
    }
  }

  // Default fallback - mark as inferred
  return { score: 50, isInferred: true };
}

// ============================================
// CRITIC SCORE CALCULATION
// ============================================

// Tier weights
const TIER_WEIGHTS: Record<OutletTier, number> = {
  1: 1.5,
  2: 1.0,
  3: 0.5,
};

/**
 * Calculate weighted critic score from reviews
 */
export function calculateCriticScore(reviews: CriticReview[]): CriticScore {
  if (reviews.length === 0) {
    return {
      score: 0,
      reviewCount: 0,
      reviews: [],
      lastUpdated: new Date().toISOString(),
      calculationNotes: 'No reviews available',
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const review of reviews) {
    const tierWeight = TIER_WEIGHTS[review.tier];
    // Reduce weight for inferred scores
    const inferredPenalty = review.isInferred ? 0.5 : 1;
    const weight = tierWeight * inferredPenalty;

    weightedSum += review.mappedScore * weight;
    totalWeight += weight;
  }

  const score = Math.round(weightedSum / totalWeight);

  return {
    score,
    reviewCount: reviews.length,
    reviews,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================
// AUDIENCE SCORE CALCULATION
// ============================================

// Default platform weights
const PLATFORM_WEIGHTS: Record<string, number> = {
  showscore: 0.50,
  google: 0.30,
  mezzanine: 0.20,
  other: 0.10,
};

/**
 * Calculate weighted audience score from platform data
 */
export function calculateAudienceScore(platforms: AudiencePlatform[]): AudienceScore {
  if (platforms.length === 0) {
    return {
      score: 0,
      platforms: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let totalReviews = 0;

  for (const platform of platforms) {
    const weight = PLATFORM_WEIGHTS[platform.platform] || 0.1;
    weightedSum += platform.mappedScore * weight;
    totalWeight += weight;
    if (platform.reviewCount) {
      totalReviews += platform.reviewCount;
    }
  }

  const score = Math.round(weightedSum / totalWeight);

  // Check for divergence between platforms
  let divergenceWarning: string | undefined;
  if (platforms.length >= 2) {
    const scores = platforms.map(p => p.mappedScore);
    const maxDiff = Math.max(...scores) - Math.min(...scores);
    if (maxDiff > 20) {
      divergenceWarning = `Platform scores vary by ${maxDiff} points. Individual scores shown for transparency.`;
    }
  }

  return {
    score,
    platforms,
    totalReviewCount: totalReviews > 0 ? totalReviews : undefined,
    divergenceWarning,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================
// BUZZ SCORE CALCULATION
// ============================================

/**
 * Calculate buzz score from thread data
 * Volume (0-50) + Sentiment (0-50) = Buzz (0-100)
 */
export function calculateBuzzScore(
  threads: BuzzThread[],
  baselineActivity: number = 10 // Expected threads for "average" buzz
): BuzzScore {
  if (threads.length === 0) {
    return {
      score: 0,
      volumeScore: 0,
      sentimentScore: 0,
      threads: [],
      volumeNote: 'No recent activity tracked',
      sentimentNote: 'Insufficient data',
      lastUpdated: new Date().toISOString(),
    };
  }

  // Calculate volume score (0-50)
  // Based on number of threads and total engagement
  const totalEngagement = threads.reduce((sum, t) => sum + t.upvotes + t.commentCount, 0);
  const volumeRatio = Math.min(2, threads.length / baselineActivity); // Cap at 2x baseline
  const engagementBonus = Math.min(10, Math.log10(totalEngagement + 1) * 3);
  const volumeScore = Math.round(Math.min(50, (volumeRatio * 20) + engagementBonus));

  // Calculate sentiment score (0-50)
  // Weight by engagement
  let sentimentSum = 0;
  let sentimentWeight = 0;
  const sentimentValues = { positive: 50, mixed: 25, negative: 0 };

  for (const thread of threads) {
    const engagement = thread.upvotes + thread.commentCount;
    const weight = Math.log10(engagement + 10); // Log scale to prevent one viral thread from dominating
    sentimentSum += sentimentValues[thread.sentiment] * weight;
    sentimentWeight += weight;
  }

  const sentimentScore = Math.round(sentimentWeight > 0 ? sentimentSum / sentimentWeight : 25);

  // Check for staleness (threads older than 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentThreads = threads.filter(t => new Date(t.date) >= thirtyDaysAgo);
  const stalenessPenalty = recentThreads.length < threads.length / 2 ? 10 : 0;

  const totalScore = Math.max(0, volumeScore + sentimentScore - stalenessPenalty);

  // Generate notes
  const volumeNote = volumeScore >= 35
    ? 'High activity level'
    : volumeScore >= 20
    ? 'Moderate activity level'
    : 'Limited recent activity';

  const sentimentNote = sentimentScore >= 35
    ? 'Predominantly positive sentiment'
    : sentimentScore >= 20
    ? 'Mixed sentiment'
    : 'Predominantly negative sentiment';

  return {
    score: totalScore,
    volumeScore,
    sentimentScore,
    threads,
    volumeNote,
    sentimentNote,
    lastUpdated: new Date().toISOString(),
    stalenessPenalty: stalenessPenalty > 0 ? stalenessPenalty : undefined,
  };
}

// ============================================
// OVERALL METASCORE CALCULATION
// ============================================

/**
 * Calculate overall metascore from component scores
 */
export function calculateMetascore(
  criticScore: number | undefined,
  audienceScore: number | undefined,
  buzzScore: number | undefined,
  weights: MetascoreWeights = DEFAULT_WEIGHTS
): Metascore | undefined {
  // Need at least one score to calculate
  if (criticScore === undefined && audienceScore === undefined && buzzScore === undefined) {
    return undefined;
  }

  // Adjust weights based on available data
  let adjustedWeights = { ...weights };
  let totalWeight = 0;

  if (criticScore !== undefined) totalWeight += weights.critic;
  else adjustedWeights.critic = 0;

  if (audienceScore !== undefined) totalWeight += weights.audience;
  else adjustedWeights.audience = 0;

  if (buzzScore !== undefined) totalWeight += weights.buzz;
  else adjustedWeights.buzz = 0;

  // Normalize weights
  if (totalWeight > 0) {
    adjustedWeights.critic = adjustedWeights.critic / totalWeight;
    adjustedWeights.audience = adjustedWeights.audience / totalWeight;
    adjustedWeights.buzz = adjustedWeights.buzz / totalWeight;
  }

  // Calculate weighted score
  const score = Math.round(
    (criticScore ?? 0) * adjustedWeights.critic +
    (audienceScore ?? 0) * adjustedWeights.audience +
    (buzzScore ?? 0) * adjustedWeights.buzz
  );

  return {
    score,
    weights: adjustedWeights,
    componentScores: {
      critic: criticScore ?? 0,
      audience: audienceScore ?? 0,
      buzz: buzzScore ?? 0,
    },
    calculatedAt: new Date().toISOString(),
  };
}

// ============================================
// CONFIDENCE ASSESSMENT
// ============================================

/**
 * Assess confidence level based on data quality
 */
export function assessConfidence(
  criticScore?: CriticScore,
  audienceScore?: AudienceScore,
  buzzScore?: BuzzScore,
  showStatus?: string
): Confidence {
  const reasons: string[] = [];
  let score = 0;

  // Critic data quality
  if (criticScore) {
    const tier1Count = criticScore.reviews.filter(r => r.tier === 1).length;
    if (criticScore.reviewCount >= 10 && tier1Count >= 3) {
      score += 3;
    } else if (criticScore.reviewCount >= 5) {
      score += 2;
      reasons.push(`${criticScore.reviewCount} critic reviews (10+ preferred)`);
    } else if (criticScore.reviewCount > 0) {
      score += 1;
      reasons.push(`Only ${criticScore.reviewCount} critic reviews`);
    } else {
      reasons.push('No critic reviews');
    }

    // Check for inferred scores
    const inferredCount = criticScore.reviews.filter(r => r.isInferred).length;
    if (inferredCount > criticScore.reviewCount / 2) {
      score -= 1;
      reasons.push('Many scores inferred from sentiment');
    }
  } else {
    reasons.push('No critic data');
  }

  // Audience data quality
  if (audienceScore) {
    if (audienceScore.platforms.length >= 2 && !audienceScore.divergenceWarning) {
      score += 2;
    } else if (audienceScore.platforms.length >= 1) {
      score += 1;
      if (audienceScore.divergenceWarning) {
        reasons.push('Audience platforms show divergent scores');
      }
    }
  } else {
    reasons.push('No audience data');
  }

  // Buzz data quality
  if (buzzScore && buzzScore.threads.length >= 5) {
    score += 1;
  }

  // Show status
  if (showStatus === 'previews') {
    score -= 1;
    reasons.push('Show still in previews');
  }

  // Determine level
  let level: ConfidenceLevel;
  if (score >= 5) {
    level = 'high';
  } else if (score >= 3) {
    level = 'medium';
  } else {
    level = 'low';
  }

  // Add positive reason if high confidence
  if (level === 'high' && reasons.length === 0) {
    reasons.push('Comprehensive data across multiple sources');
  }

  return { level, reasons };
}

// ============================================
// UTILITY: GET SCORE COLOR CLASS
// ============================================

export function getScoreColorClass(score: number): string {
  if (score >= 70) return 'text-score-high';
  if (score >= 50) return 'text-score-medium';
  return 'text-score-low';
}

export function getScoreBgClass(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}
