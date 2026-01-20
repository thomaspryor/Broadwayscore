// Scoring Engine - Computes all scores from raw data using config
// This is the core calculation engine that powers the site
//
// REPEATABILITY GUARANTEE:
// - Same input data + same config = same output scores (deterministic)
// - No randomness, no time-based variations in scoring
// - All calculations use explicit, documented formulas
// - Sorting is stable (by secondary keys when primary keys are equal)
// - Config changes are versioned and auditable

import {
  METHODOLOGY_VERSION,
  METHODOLOGY_DATE,
  COMPONENT_WEIGHTS,
  OUTLET_TIERS,
  DEFAULT_TIER_WEIGHT,
  LETTER_GRADE_MAP,
  SENTIMENT_MAP,
  AUDIENCE_PLATFORM_WEIGHTS,
  AUDIENCE_MIN_REVIEWS,
  BUZZ_CONFIG,
  CONFIDENCE_RULES,
  INFERRED_PENALTY,
  AUDIENCE_DIVERGENCE_THRESHOLD,
} from '@/config/scoring';

// ===========================================
// TYPES
// ===========================================

export interface RawShow {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  closingDate: string | null;
  status: string;
  type: string;
  runtime: string;
  intermissions: number;
}

export interface RawReview {
  showId: string;
  outlet: string;
  criticName?: string;
  originalRating: string;
  url: string;
  publishDate: string;
  pullQuote?: string;
}

export interface RawAudience {
  showId: string;
  platform: string;
  platformName: string;
  averageRating: number;
  maxRating: number;
  reviewCount: number;
  url?: string;
  lastUpdated: string;
}

export interface RawBuzzThread {
  showId: string;
  platform: string;
  subreddit?: string;
  title: string;
  url: string;
  upvotes: number;
  commentCount: number;
  sentiment: 'positive' | 'mixed' | 'negative';
  date: string;
  summary?: string;
}

export interface ComputedReview extends RawReview {
  tier: 1 | 2 | 3;
  weight: number;
  mappedScore: number;
  isInferred: boolean;
}

export interface ComputedAudience extends RawAudience {
  mappedScore: number;
  weight: number;
}

export interface CriticScoreResult {
  score: number;
  reviewCount: number;
  tier1Count: number;
  reviews: ComputedReview[];
}

export interface AudienceScoreResult {
  score: number;
  platforms: ComputedAudience[];
  totalReviewCount: number;
  divergenceWarning?: string;
}

export interface BuzzScoreResult {
  score: number;
  volumeScore: number;
  sentimentScore: number;
  volumeNote: string;
  sentimentNote: string;
  threads: RawBuzzThread[];
  stalenessPenalty?: number;
}

export interface ConfidenceResult {
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface ComputedShow {
  // Metadata
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  closingDate: string | null;
  status: string;
  type: string;
  runtime: string;

  // Computed scores
  criticScore: CriticScoreResult | null;
  audienceScore: AudienceScoreResult | null;
  buzzScore: BuzzScoreResult | null;
  metascore: number | null;

  // Confidence
  confidence: ConfidenceResult;

  // Methodology version
  methodologyVersion: string;
  methodologyDate: string;
  computedAt: string;
}

// ===========================================
// RATING NORMALIZATION
// ===========================================

export function normalizeRating(rating: string): { score: number; isInferred: boolean } {
  const normalized = rating.trim().toLowerCase();

  // Star ratings: "4/5", "3.5/5", "4 out of 5"
  const starMatch = normalized.match(/^(\d+\.?\d*)\s*(?:\/|out of)\s*(\d+)/);
  if (starMatch) {
    const [, value, max] = starMatch;
    return { score: Math.round((parseFloat(value) / parseFloat(max)) * 100), isInferred: false };
  }

  // Letter grades
  const upperRating = rating.trim().toUpperCase();
  if (LETTER_GRADE_MAP[upperRating] !== undefined) {
    return { score: LETTER_GRADE_MAP[upperRating], isInferred: false };
  }

  // Percentage
  const percentMatch = normalized.match(/^(\d+)\s*%?$/);
  if (percentMatch) {
    return { score: Math.min(100, parseInt(percentMatch[1])), isInferred: false };
  }

  // Sentiment keywords (inferred)
  for (const [sentiment, score] of Object.entries(SENTIMENT_MAP)) {
    if (normalized.includes(sentiment.toLowerCase())) {
      return { score, isInferred: true };
    }
  }

  // Default fallback
  return { score: 50, isInferred: true };
}

// ===========================================
// CRITIC SCORE CALCULATION
// ===========================================

export function computeCriticScore(reviews: RawReview[]): CriticScoreResult | null {
  if (reviews.length === 0) return null;

  const computedReviews: ComputedReview[] = reviews.map(review => {
    const outletConfig = OUTLET_TIERS[review.outlet];
    const tier = outletConfig?.tier ?? 3;
    const baseWeight = outletConfig?.weight ?? DEFAULT_TIER_WEIGHT;

    const { score: mappedScore, isInferred } = normalizeRating(review.originalRating);
    const weight = baseWeight * (isInferred ? INFERRED_PENALTY : 1);

    return {
      ...review,
      tier,
      weight,
      mappedScore,
      isInferred,
    };
  });

  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;

  for (const review of computedReviews) {
    weightedSum += review.mappedScore * review.weight;
    totalWeight += review.weight;
  }

  const score = Math.round(weightedSum / totalWeight);
  const tier1Count = computedReviews.filter(r => r.tier === 1).length;

  return {
    score,
    reviewCount: reviews.length,
    tier1Count,
    reviews: computedReviews.sort((a, b) => a.tier - b.tier || b.mappedScore - a.mappedScore),
  };
}

// ===========================================
// AUDIENCE SCORE CALCULATION
// ===========================================

export function computeAudienceScore(audienceData: RawAudience[]): AudienceScoreResult | null {
  if (audienceData.length === 0) return null;

  const computedPlatforms: ComputedAudience[] = audienceData.map(platform => {
    // Normalize to 0-100
    const mappedScore = Math.round((platform.averageRating / platform.maxRating) * 100);
    const weight = AUDIENCE_PLATFORM_WEIGHTS[platform.platform] ?? AUDIENCE_PLATFORM_WEIGHTS['other'];

    return {
      ...platform,
      mappedScore,
      weight,
    };
  });

  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  let totalReviewCount = 0;

  for (const platform of computedPlatforms) {
    weightedSum += platform.mappedScore * platform.weight;
    totalWeight += platform.weight;
    totalReviewCount += platform.reviewCount || 0;
  }

  const score = Math.round(weightedSum / totalWeight);

  // Check for divergence
  let divergenceWarning: string | undefined;
  if (computedPlatforms.length >= 2) {
    const scores = computedPlatforms.map(p => p.mappedScore);
    const maxDiff = Math.max(...scores) - Math.min(...scores);
    if (maxDiff > AUDIENCE_DIVERGENCE_THRESHOLD) {
      divergenceWarning = `Platform scores vary by ${maxDiff} points. Individual scores shown for transparency.`;
    }
  }

  return {
    score,
    platforms: computedPlatforms,
    totalReviewCount,
    divergenceWarning,
  };
}

// ===========================================
// BUZZ SCORE CALCULATION
// ===========================================

export function computeBuzzScore(threads: RawBuzzThread[]): BuzzScoreResult | null {
  if (threads.length === 0) return null;

  const { baselineThreads, volumeMaxScore, sentimentMaxScore, sentimentValues, stalenessThresholdDays, stalenessPenalty: penaltyAmount } = BUZZ_CONFIG;

  // Volume score (0-50)
  const totalEngagement = threads.reduce((sum, t) => sum + t.upvotes + t.commentCount, 0);
  const volumeRatio = Math.min(2, threads.length / baselineThreads);
  const engagementBonus = Math.min(10, Math.log10(totalEngagement + 1) * 3);
  const volumeScore = Math.round(Math.min(volumeMaxScore, (volumeRatio * 20) + engagementBonus));

  // Sentiment score (0-50)
  let sentimentSum = 0;
  let sentimentWeight = 0;

  for (const thread of threads) {
    const engagement = thread.upvotes + thread.commentCount;
    const weight = Math.log10(engagement + 10);
    sentimentSum += sentimentValues[thread.sentiment] * weight;
    sentimentWeight += weight;
  }

  const sentimentScore = Math.round(sentimentWeight > 0 ? sentimentSum / sentimentWeight : 25);

  // Staleness check
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - stalenessThresholdDays);
  const recentThreads = threads.filter(t => new Date(t.date) >= cutoffDate);
  const stalenessPenalty = recentThreads.length < threads.length / 2 ? penaltyAmount : 0;

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
    volumeNote,
    sentimentNote,
    threads: threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    stalenessPenalty: stalenessPenalty > 0 ? stalenessPenalty : undefined,
  };
}

// ===========================================
// OVERALL METASCORE
// ===========================================

export function computeMetascore(
  criticScore: number | null,
  audienceScore: number | null,
  buzzScore: number | null
): number | null {
  const scores: { value: number; weight: number }[] = [];

  if (criticScore !== null) {
    scores.push({ value: criticScore, weight: COMPONENT_WEIGHTS.critic });
  }
  if (audienceScore !== null) {
    scores.push({ value: audienceScore, weight: COMPONENT_WEIGHTS.audience });
  }
  if (buzzScore !== null) {
    scores.push({ value: buzzScore, weight: COMPONENT_WEIGHTS.buzz });
  }

  if (scores.length === 0) return null;

  // Normalize weights
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const normalizedScores = scores.map(s => ({
    value: s.value,
    weight: s.weight / totalWeight,
  }));

  // Weighted average
  return Math.round(normalizedScores.reduce((sum, s) => sum + s.value * s.weight, 0));
}

// ===========================================
// CONFIDENCE ASSESSMENT
// ===========================================

export function assessConfidence(
  criticScore: CriticScoreResult | null,
  audienceScore: AudienceScoreResult | null,
  showStatus: string
): ConfidenceResult {
  const reasons: string[] = [];
  let score = 0;

  // Critic data
  if (criticScore) {
    if (criticScore.reviewCount >= CONFIDENCE_RULES.high.minCriticReviews &&
        criticScore.tier1Count >= CONFIDENCE_RULES.high.minTier1Reviews) {
      score += 3;
    } else if (criticScore.reviewCount >= CONFIDENCE_RULES.medium.minCriticReviews) {
      score += 2;
      reasons.push(`${criticScore.reviewCount} critic reviews (${CONFIDENCE_RULES.high.minCriticReviews}+ preferred)`);
    } else {
      score += 1;
      reasons.push(`Only ${criticScore.reviewCount} critic reviews`);
    }

    // Inferred penalty
    const inferredCount = criticScore.reviews.filter(r => r.isInferred).length;
    if (inferredCount > criticScore.reviewCount / 2) {
      score -= 1;
      reasons.push('Many scores inferred from sentiment');
    }
  } else {
    reasons.push('No critic data');
  }

  // Audience data
  if (audienceScore) {
    if (audienceScore.platforms.length >= CONFIDENCE_RULES.high.minAudiencePlatforms &&
        !audienceScore.divergenceWarning) {
      score += 2;
    } else if (audienceScore.platforms.length >= CONFIDENCE_RULES.medium.minAudiencePlatforms) {
      score += 1;
      if (audienceScore.divergenceWarning) {
        reasons.push('Audience platforms show divergent scores');
      }
    }
  } else {
    reasons.push('No audience data');
  }

  // Show status
  if (showStatus === 'previews') {
    score -= 1;
    reasons.push('Show still in previews');
  }

  // Determine level
  let level: 'high' | 'medium' | 'low';
  if (score >= 4) {
    level = 'high';
  } else if (score >= 2) {
    level = 'medium';
  } else {
    level = 'low';
  }

  if (level === 'high' && reasons.length === 0) {
    reasons.push('Comprehensive data across multiple sources');
  }

  return { level, reasons };
}

// ===========================================
// MAIN: COMPUTE ALL SHOW DATA
// ===========================================

export function computeShowData(
  show: RawShow,
  reviews: RawReview[],
  audienceData: RawAudience[],
  buzzThreads: RawBuzzThread[]
): ComputedShow {
  const showReviews = reviews.filter(r => r.showId === show.id);
  const showAudience = audienceData.filter(a => a.showId === show.id);
  const showBuzz = buzzThreads.filter(t => t.showId === show.id);

  const criticScore = computeCriticScore(showReviews);
  const audienceScore = computeAudienceScore(showAudience);
  const buzzScore = computeBuzzScore(showBuzz);

  const metascore = computeMetascore(
    criticScore?.score ?? null,
    audienceScore?.score ?? null,
    buzzScore?.score ?? null
  );

  const confidence = assessConfidence(criticScore, audienceScore, show.status);

  return {
    id: show.id,
    title: show.title,
    slug: show.slug,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate,
    status: show.status,
    type: show.type,
    runtime: show.runtime,
    criticScore,
    audienceScore,
    buzzScore,
    metascore,
    confidence,
    methodologyVersion: METHODOLOGY_VERSION,
    methodologyDate: METHODOLOGY_DATE,
    computedAt: new Date().toISOString(),
  };
}

// ===========================================
// EXPORT CONFIG FOR METHODOLOGY PAGE
// ===========================================

export function getMethodologyConfig() {
  return {
    version: METHODOLOGY_VERSION,
    date: METHODOLOGY_DATE,
    componentWeights: COMPONENT_WEIGHTS,
    outletTiers: OUTLET_TIERS,
    letterGradeMap: LETTER_GRADE_MAP,
    sentimentMap: SENTIMENT_MAP,
    audiencePlatformWeights: AUDIENCE_PLATFORM_WEIGHTS,
    buzzConfig: BUZZ_CONFIG,
    confidenceRules: CONFIDENCE_RULES,
    inferredPenalty: INFERRED_PENALTY,
    divergenceThreshold: AUDIENCE_DIVERGENCE_THRESHOLD,
  };
}
