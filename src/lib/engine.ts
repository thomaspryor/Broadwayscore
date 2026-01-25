// Scoring Engine - Computes all scores from raw data using config
// Based on user's Google Sheet methodology
//
// REPEATABILITY GUARANTEE:
// - Same input data + same config = same output scores (deterministic)
// - No randomness, no time-based variations in scoring
// - All calculations use explicit, documented formulas

import {
  METHODOLOGY_VERSION,
  METHODOLOGY_DATE,
  COMPONENT_WEIGHTS,
  OUTLET_TIERS,
  TIER_WEIGHTS,
  DEFAULT_TIER,
  DESIGNATION_BUMPS,
  LETTER_GRADE_MAP,
  BUCKET_SCORE_MAP,
  THUMB_SCORE_MAP,
  AUDIENCE_PLATFORM_WEIGHTS,
  BUZZ_CONFIG,
  CONFIDENCE_THRESHOLDS,
  AUDIENCE_DIVERGENCE_THRESHOLD,
  getCriticLabel,
} from '@/config/scoring';

// ===========================================
// TYPES
// ===========================================

export interface ShowImages {
  hero?: string;        // Full-width hero image (1920x1080 or similar)
  thumbnail?: string;   // Square thumbnail (400x400)
  poster?: string;      // Poster image (2:3 ratio)
}

export interface TicketLink {
  platform: string;     // TodayTix, Telecharge, Official, etc.
  url: string;
  priceFrom?: number;   // Starting price in dollars
}

export interface CastMember {
  name: string;
  role: string;         // Character name or "Ensemble"
}

export interface CreativeMember {
  name: string;
  role: string;         // Director, Book, Music, Lyrics, Choreographer, etc.
}

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
  images?: ShowImages;
  // New fields
  synopsis?: string;
  ageRecommendation?: string;  // e.g., "Ages 12+", "All ages"
  limitedRun?: boolean;        // true for shows with announced closing dates
  previewsStartDate?: string;  // First preview performance (for upcoming shows)
  ticketLinks?: TicketLink[];
  officialUrl?: string;
  trailerUrl?: string;
  cast?: CastMember[];
  creativeTeam?: CreativeMember[];
  tags?: string[];             // Musical, Comedy, Romance, New, etc.
  theaterAddress?: string;
}

export interface RawReview {
  showId: string;
  outletId?: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  // New fields from spreadsheet methodology
  assignedScore?: number;          // Manual 0-100 score
  originalRating?: string;         // e.g., "B+", "3 stars", "4/5"
  bucket?: string;                 // Rave, Positive, Mixed, Negative, Pan
  thumb?: string;                  // Up, Flat, Down
  designation?: string;            // Critics_Pick, Critics_Choice, etc.
  quote?: string;                  // Direct quote from the review
  summary?: string;                // Third-person summary of the review
  pullQuote?: string;              // Legacy field - use quote/summary instead
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

export interface ComputedReview {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3;
  tierWeight: number;
  assignedScore: number;
  bucketScore?: number;
  thumbScore?: number;
  reviewScore: number;      // The computed score used for averaging
  weightedScore: number;    // reviewScore × tierWeight
  designation?: string;
  quote?: string;               // Direct quote from the review
  summary?: string;             // Third-person summary of the review
  pullQuote?: string;           // Legacy field
  originalRating?: string;      // Original rating format (e.g., "4/5 stars", "B+", "Positive")
}

export interface ComputedAudience extends RawAudience {
  mappedScore: number;
  weight: number;
}

export interface CriticScoreResult {
  score: number;                // Simple average of review scores
  weightedScore: number;        // Weighted average using tier weights
  reviewCount: number;
  tier1Count: number;
  label: string;                // Rave, Positive, Mixed, Negative
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
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  closingDate: string | null;
  status: string;
  type: string;
  runtime: string;
  intermissions?: number;
  images?: ShowImages;
  // New fields
  synopsis?: string;
  ageRecommendation?: string;
  limitedRun?: boolean;
  previewsStartDate?: string;  // For upcoming shows
  ticketLinks?: TicketLink[];
  officialUrl?: string;
  trailerUrl?: string;
  cast?: CastMember[];
  creativeTeam?: CreativeMember[];
  tags?: string[];
  theaterAddress?: string;
  // Scores
  criticScore: CriticScoreResult | null;
  audienceScore: AudienceScoreResult | null;
  buzzScore: BuzzScoreResult | null;
  compositeScore: number | null;
  confidence: ConfidenceResult;
  methodologyVersion: string;
  methodologyDate: string;
  computedAt: string;
}

// ===========================================
// HELPER: GET OUTLET CONFIG
// ===========================================

function getOutletConfig(outletId?: string, outletName?: string) {
  // Try by ID first
  if (outletId && OUTLET_TIERS[outletId]) {
    return { ...OUTLET_TIERS[outletId], id: outletId };
  }
  // Fallback to name lookup
  if (outletName) {
    for (const [id, config] of Object.entries(OUTLET_TIERS)) {
      if (config.name.toLowerCase() === outletName.toLowerCase()) {
        return { ...config, id };
      }
    }
  }
  // Default tier 3
  return {
    tier: DEFAULT_TIER as 1 | 2 | 3,
    name: outletName || 'Unknown',
    scoreFormat: 'text_bucket',
    id: outletId || 'UNKNOWN',
  };
}

// ===========================================
// HELPER: PARSE RATING TO SCORE
// ===========================================

function parseOriginalRating(rating: string): number | null {
  const normalized = rating.trim();

  // Letter grades (B+, A-, etc.)
  const upperRating = normalized.toUpperCase();
  if (LETTER_GRADE_MAP[upperRating] !== undefined) {
    return LETTER_GRADE_MAP[upperRating];
  }

  // Star ratings: "4/5", "3.5/5", "3 stars"
  const starMatch = normalized.match(/^(\d+\.?\d*)\s*(?:\/\s*(\d+)|stars?)/i);
  if (starMatch) {
    const value = parseFloat(starMatch[1]);
    const max = starMatch[2] ? parseFloat(starMatch[2]) : 5;
    return Math.round((value / max) * 100);
  }

  // Percentage
  const percentMatch = normalized.match(/^(\d+)\s*%?$/);
  if (percentMatch) {
    return Math.min(100, parseInt(percentMatch[1]));
  }

  return null;
}

// ===========================================
// CRITIC SCORE CALCULATION
// ===========================================

export function computeCriticScore(reviews: RawReview[]): CriticScoreResult | null {
  if (reviews.length === 0) return null;

  const computedReviews: ComputedReview[] = reviews.map(review => {
    const outletConfig = getOutletConfig(review.outletId, review.outlet);
    const tier = outletConfig.tier;
    const tierWeight = TIER_WEIGHTS[tier];

    // Determine the review score
    // Priority: assignedScore > originalRating > bucket > thumb
    let assignedScore: number;
    let bucketScore: number | undefined;
    let thumbScore: number | undefined;

    if (review.assignedScore !== undefined) {
      assignedScore = review.assignedScore;
    } else if (review.originalRating) {
      const parsed = parseOriginalRating(review.originalRating);
      assignedScore = parsed ?? 50;
    } else {
      assignedScore = 50; // Default
    }

    // Get bucket and thumb scores for reference/averaging
    if (review.bucket) {
      bucketScore = BUCKET_SCORE_MAP[review.bucket];
    }
    if (review.thumb) {
      thumbScore = THUMB_SCORE_MAP[review.thumb];
    }

    // Calculate final review score
    // If we have both assigned score and a mapped score, average them
    // Otherwise use the assigned score directly
    let reviewScore = assignedScore;

    // Apply designation bump if applicable
    if (review.designation && DESIGNATION_BUMPS[review.designation]) {
      reviewScore = Math.min(100, reviewScore + DESIGNATION_BUMPS[review.designation]);
    }

    // Calculate weighted score
    const weightedScore = reviewScore * tierWeight;

    return {
      showId: review.showId,
      outletId: outletConfig.id,
      outlet: review.outlet,
      criticName: review.criticName,
      url: review.url,
      publishDate: review.publishDate,
      tier,
      tierWeight,
      assignedScore,
      bucketScore,
      thumbScore,
      reviewScore,
      weightedScore,
      designation: review.designation,
      quote: review.quote,
      summary: review.summary,
      pullQuote: review.pullQuote,
      originalRating: review.originalRating,
    };
  });

  // Calculate scores
  // Simple average of all review scores
  const simpleSum = computedReviews.reduce((sum, r) => sum + r.reviewScore, 0);
  const simpleScore = Math.round((simpleSum / computedReviews.length) * 100) / 100;

  // Weighted average using tier weights
  const weightedSum = computedReviews.reduce((sum, r) => sum + r.weightedScore, 0);
  const totalWeight = computedReviews.reduce((sum, r) => sum + r.tierWeight, 0);
  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;

  const tier1Count = computedReviews.filter(r => r.tier === 1).length;

  return {
    score: simpleScore,
    weightedScore,
    reviewCount: reviews.length,
    tier1Count,
    label: getCriticLabel(simpleScore),
    reviews: computedReviews.sort((a, b) => b.reviewScore - a.reviewScore),
  };
}

// ===========================================
// AUDIENCE SCORE CALCULATION
// ===========================================

export function computeAudienceScore(audienceData: RawAudience[]): AudienceScoreResult | null {
  if (audienceData.length === 0) return null;

  const computedPlatforms: ComputedAudience[] = audienceData.map(platform => {
    const mappedScore = Math.round((platform.averageRating / platform.maxRating) * 100);
    const weight = AUDIENCE_PLATFORM_WEIGHTS[platform.platform] ?? AUDIENCE_PLATFORM_WEIGHTS['other'];

    return {
      ...platform,
      mappedScore,
      weight,
    };
  });

  let weightedSum = 0;
  let totalWeight = 0;
  let totalReviewCount = 0;

  for (const platform of computedPlatforms) {
    weightedSum += platform.mappedScore * platform.weight;
    totalWeight += platform.weight;
    totalReviewCount += platform.reviewCount || 0;
  }

  const score = Math.round(weightedSum / totalWeight);

  let divergenceWarning: string | undefined;
  if (computedPlatforms.length >= 2) {
    const scores = computedPlatforms.map(p => p.mappedScore);
    const maxDiff = Math.max(...scores) - Math.min(...scores);
    if (maxDiff > AUDIENCE_DIVERGENCE_THRESHOLD) {
      divergenceWarning = `Platform scores vary by ${maxDiff} points.`;
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

  const totalEngagement = threads.reduce((sum, t) => sum + t.upvotes + t.commentCount, 0);
  const volumeRatio = Math.min(2, threads.length / baselineThreads);
  const engagementBonus = Math.min(10, Math.log10(totalEngagement + 1) * 3);
  const volumeScore = Math.round(Math.min(volumeMaxScore, (volumeRatio * 20) + engagementBonus));

  let sentimentSum = 0;
  let sentimentWeight = 0;

  for (const thread of threads) {
    const engagement = thread.upvotes + thread.commentCount;
    const weight = Math.log10(engagement + 10);
    sentimentSum += sentimentValues[thread.sentiment] * weight;
    sentimentWeight += weight;
  }

  const sentimentScore = Math.round(sentimentWeight > 0 ? sentimentSum / sentimentWeight : 25);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - stalenessThresholdDays);
  const recentThreads = threads.filter(t => new Date(t.date) >= cutoffDate);
  const stalenessPenalty = recentThreads.length < threads.length / 2 ? penaltyAmount : 0;

  const totalScore = Math.max(0, volumeScore + sentimentScore - stalenessPenalty);

  const volumeNote = volumeScore >= 35 ? 'High activity level' : volumeScore >= 20 ? 'Moderate activity level' : 'Limited recent activity';
  const sentimentNote = sentimentScore >= 35 ? 'Predominantly positive sentiment' : sentimentScore >= 20 ? 'Mixed sentiment' : 'Predominantly negative sentiment';

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
// OVERALL COMPOSITE SCORE
// ===========================================

export function computeCompositeScore(
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

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const normalizedScores = scores.map(s => ({
    value: s.value,
    weight: s.weight / totalWeight,
  }));

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

  if (!criticScore) {
    return { level: 'low', reasons: ['No critic reviews'] };
  }

  const reviewCount = criticScore.reviewCount;

  if (reviewCount >= CONFIDENCE_THRESHOLDS.high) {
    if (criticScore.tier1Count >= 2) {
      return { level: 'high', reasons: [`${reviewCount} reviews including ${criticScore.tier1Count} Tier 1`] };
    }
    reasons.push(`${reviewCount} reviews but only ${criticScore.tier1Count} Tier 1`);
    return { level: 'high', reasons };
  }

  if (reviewCount >= CONFIDENCE_THRESHOLDS.medium) {
    reasons.push(`${reviewCount} reviews (${CONFIDENCE_THRESHOLDS.high}+ preferred)`);
    return { level: 'medium', reasons };
  }

  reasons.push(`Only ${reviewCount} reviews`);
  return { level: 'low', reasons };
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

  const criticScore = computeCriticScore(showReviews);

  // V1: composite score = critic score (audience/buzz coming later)
  const compositeScore = criticScore?.weightedScore ? Math.round(criticScore.weightedScore) : null;

  const confidence = assessConfidence(criticScore, null, show.status);

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
    intermissions: show.intermissions,
    images: show.images,
    // Pass through new fields
    synopsis: show.synopsis,
    ageRecommendation: show.ageRecommendation,
    limitedRun: show.limitedRun,
    previewsStartDate: show.previewsStartDate,
    ticketLinks: show.ticketLinks,
    officialUrl: show.officialUrl,
    trailerUrl: show.trailerUrl,
    cast: show.cast,
    creativeTeam: show.creativeTeam,
    tags: show.tags,
    theaterAddress: show.theaterAddress,
    // Scores
    criticScore,
    audienceScore: null,
    buzzScore: null,
    compositeScore,
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
    tierWeights: TIER_WEIGHTS,
    outletTiers: OUTLET_TIERS,
    letterGradeMap: LETTER_GRADE_MAP,
    bucketScoreMap: BUCKET_SCORE_MAP,
    thumbScoreMap: THUMB_SCORE_MAP,
    designationBumps: DESIGNATION_BUMPS,
    audiencePlatformWeights: AUDIENCE_PLATFORM_WEIGHTS,
    buzzConfig: BUZZ_CONFIG,
    confidenceThresholds: CONFIDENCE_THRESHOLDS,
    divergenceThreshold: AUDIENCE_DIVERGENCE_THRESHOLD,
  };
}
