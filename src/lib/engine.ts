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
  DESIGNATION_FLOORS,
  LETTER_GRADE_MAP,
  BUCKET_SCORE_MAP,
  THUMB_SCORE_MAP,
  AUDIENCE_PLATFORM_WEIGHTS,
  BUZZ_CONFIG,
  CONFIDENCE_THRESHOLDS,
  AUDIENCE_DIVERGENCE_THRESHOLD,
  TOP_CRITICS,
  getCriticLabel,
  SCORE_DISPLAY_YEAR_CUTOFF,
  MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF,
  LOW_CONF_SCORE_SOURCES,
  shouldHideReviews,
} from '@/config/scoring';
import { getRegistryTier } from './outlet-id-mapper';
import { getMarketDate } from './date-utils';
import { isOperaShow } from './show-market';

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
  isOfficial?: boolean; // True = official box office vendor (lowest fees). See theatre-vendor mapping.
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
  category?: string;  // 'broadway' (default), 'off-broadway', or 'west-end'
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
  creativeTeam?: CreativeMember[];
  tags?: string[];             // Musical, Comedy, Romance, New, etc.
  theaterAddress?: string;
  // Revival and historical tracking
  isRevival?: boolean;                 // true for revival productions
  originalProductionId?: string | null; // ID of the original production (e.g., "cabaret-1966")
  productionNumber?: number;            // 1 for original, 2 for first revival, etc.
  season?: string;                      // Broadway season (e.g., "2024-2025")
  // Homepage curation overrides (off-Broadway shows surfaced on the Broadway grid).
  // See src/lib/homepage-notability.ts. Editorial escape hatches over the auto rule.
  homepageInclude?: boolean;           // force onto homepage grid (e.g. star-driven previews)
  homepageExclude?: boolean;           // veto from homepage grid
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
  // Scoring confidence metadata (from rebuild)
  scoreSource?: string;        // llmScore, llmScore-lowconf, llmScore-thumb-boosted, originalScore-priority0, human-review, thumb, bwwScore-fallback
  contentTier?: string;        // complete, truncated, excerpt, stub, invalid
  scoreConfidence?: string;    // high, medium, low
  dtliThumb?: string | null;   // DTLI thumb signal
  bwwThumb?: string | null;    // BWW thumb signal
  needsReview?: boolean;       // Score doesn't reflect current signals (needs rescore)
  singleModelEmergency?: boolean; // 1-of-N ensemble models succeeded — unreliable, exclude from compositeScore
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
  tier: 1 | 2 | 3 | 4;
  tierWeight: number;
  assignedScore: number;
  bucketScore?: number;
  thumbScore?: number;
  reviewScore: number;      // The computed score used for averaging
  confidenceWeight: number; // Content quality multiplier (1.0 for full text, lower for excerpts)
  weightedScore: number;    // reviewScore × tierWeight × confidenceWeight × outletShare
  outletShare?: number;     // 1/criticCount for this outlet on this show — preserves
                            // one-vote-per-outlet weighting when an outlet publishes
                            // multiple critic reviews
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
  score: number;                // Tier-weighted average (same as weightedScore)
  weightedScore: number;        // Weighted average using tier weights
  reviewCount: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
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
  category?: string;  // 'broadway' (default), 'off-broadway', or 'west-end'
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
  creativeTeam?: CreativeMember[];
  tags?: string[];
  theaterAddress?: string;
  // Revival and historical tracking
  isRevival?: boolean;
  originalProductionId?: string | null;
  productionNumber?: number;
  season?: string;
  // Homepage curation overrides (see RawShow above / homepage-notability.ts)
  homepageInclude?: boolean;
  homepageExclude?: boolean;
  // Scores
  criticScore: CriticScoreResult | null;
  audienceScore: AudienceScoreResult | null;
  buzzScore: BuzzScoreResult | null;
  compositeScore: number | null;
  confidence: ConfidenceResult;
  // Review age context for long-running shows
  reviewYearNote: string | null;
  methodologyVersion: string;
  methodologyDate: string;
  computedAt: string;
}

// ===========================================
// HELPER: GET OUTLET CONFIG
// ===========================================

export function getOutletConfig(outletId?: string, outletName?: string, showCategory?: string) {
  // Per-region tier resolver: when showCategory is provided and the entry has
  // `tiers: { nyc, london }`, return the regional tier. Otherwise return the
  // legacy single `tier` field. (v5 — 2026-04-29)
  const resolveTier = (entry: { tier: 1 | 2 | 3 | 4; tiers?: { nyc?: 1 | 2 | 3 | 4; london?: 1 | 2 | 3 | 4 } }): 1 | 2 | 3 | 4 => {
    if (showCategory && entry.tiers) {
      const region = (showCategory === 'west-end' || showCategory === 'off-west-end') ? 'london' : 'nyc';
      const regionalTier = entry.tiers[region];
      if (regionalTier != null) return regionalTier;
    }
    return entry.tier;
  };

  // Direct lookup — OUTLET_TIERS keys are lowercase registry IDs
  if (outletId) {
    const normalized = outletId.toLowerCase().trim();
    if (OUTLET_TIERS[normalized]) {
      const entry = OUTLET_TIERS[normalized];
      return { ...entry, tier: resolveTier(entry), id: outletId };
    }
  }

  // Fallback to name lookup (rare, legacy)
  if (outletName) {
    for (const [id, config] of Object.entries(OUTLET_TIERS)) {
      if (config.name.toLowerCase() === outletName.toLowerCase()) {
        return { ...config, tier: resolveTier(config), id };
      }
    }
  }

  // Fallback to outlet-registry.json tier (covers ~775 outlets not in OUTLET_TIERS)
  if (outletId) {
    const registryTier = getRegistryTier(outletId, showCategory);
    if (registryTier) {
      return {
        tier: registryTier as 1 | 2 | 3 | 4,
        name: outletName || outletId,
        scoreFormat: 'text_bucket',
        id: outletId,
      };
    }
  }

  // Default tier 3
  return {
    tier: DEFAULT_TIER as 1 | 2 | 3 | 4,
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

export function computeCriticScore(reviews: RawReview[], showCategory?: string, showType?: string): CriticScoreResult | null {
  if (reviews.length === 0) return null;
  // Opera flat-weighting (2026-05-01): Met opera coverage doesn't follow theater's
  // tier hierarchy (Operawire/Parterre/NYCR are first-class voices, not T3 blogs).
  // Force tier=1 for all opera reviews and skip the off-market multiplier.
  // Mirrors scripts/lib/compute-critic-score.js — drift = silent score divergence.
  const isOpera = isOperaShow({ type: showType });

  // Critic-level dedup: keep one review per (outlet, critic) pair, most recent by
  // publishDate. This dedups the case where the same critic re-reviews after a cast
  // change (legitimate) but KEEPS distinct critics from the same outlet (NYSR, NYT,
  // Variety, Vulture, EW, etc. routinely publish multiple critic reviews per show).
  //
  // To prevent multi-critic outlets from getting disproportionate weight, each
  // critic's effective weight is divided by the count of distinct critics that
  // outlet has on this show. NYSR with 3 critics → each contributes (1/3) × T2,
  // summing to NYSR's full T2 vote — same total weight as a single-critic outlet.
  // Reviews with no criticName fall back to a per-outlet bucket so an unknown-author
  // review still counts as the outlet's vote.
  const byCritic = new Map<string, RawReview>();
  for (const review of reviews) {
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    const criticKey = (review.criticName || '__unknown__').toLowerCase();
    const key = `${outletKey}|${criticKey}`;
    const existing = byCritic.get(key);
    if (!existing || (review.publishDate || '') > (existing.publishDate || '')) {
      byCritic.set(key, review);
    }
  }
  const dedupedReviews = Array.from(byCritic.values());

  // Count distinct critics per outlet for per-outlet weight normalization.
  // Reviews missing criticName all share the synthetic '__unknown__' bucket so an
  // outlet that publishes one anonymous review still counts as one vote.
  const criticCountByOutlet = new Map<string, number>();
  for (const review of dedupedReviews) {
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    criticCountByOutlet.set(outletKey, (criticCountByOutlet.get(outletKey) || 0) + 1);
  }

  const computedReviews: ComputedReview[] = dedupedReviews.map(review => {
    const outletConfig = getOutletConfig(review.outletId, review.outlet, showCategory);
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const resolvedTier = isTopCritic ? 1 : outletConfig.tier;
    const tier = isOpera ? 1 : resolvedTier;
    const isOffMarket = !isOpera && (showCategory === 'off-broadway' || showCategory === 'off-west-end');
    const baseTierWeight = TIER_WEIGHTS[tier];
    const tierWeight = isOffMarket ? baseTierWeight * 0.8 : baseTierWeight;

    // Determine the review score.
    // assignedScore is the canonical scoring output from scripts/rebuild-all-reviews.js
    // (via getBestScore in scripts/lib/rebuild-helpers.js), which is the single source
    // of truth for per-review scoring including LLM calibration. There is intentionally
    // no llmScore fallback here: reviews.json does not carry an llmScore object, and
    // any future change that adds one would silently bypass calibration.
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

    // Apply designation floor and bump if applicable
    if (review.designation) {
      if (DESIGNATION_FLOORS[review.designation]) {
        reviewScore = Math.max(reviewScore, DESIGNATION_FLOORS[review.designation]);
      }
      if (DESIGNATION_BUMPS[review.designation]) {
        reviewScore = Math.min(100, reviewScore + DESIGNATION_BUMPS[review.designation]);
      }
    }

    // Calculate confidence weight based on text quality
    // Full text = full weight, excerpts = reduced weight
    // If needsReview=true, the score doesn't reflect current signals (e.g., thumb
    // was added after scoring), so don't credit the thumb until rescore happens
    const thumbReflectedInScore = !!(review.dtliThumb || review.bwwThumb) && !review.needsReview;
    let confidenceWeight = 1.0;
    if (review.contentTier === 'excerpt' || review.contentTier === 'stub') {
      confidenceWeight = thumbReflectedInScore ? 0.75 : 0.5;
    } else if (review.contentTier === 'truncated') {
      confidenceWeight = 0.85;
    }

    // Per-outlet share: when an outlet has multiple critics on this show, each
    // critic's effective weight is divided by the count so the outlet still
    // contributes one full tier-weight vote (not N votes). Equivalent to
    // averaging critic scores within the outlet then tier-weighting that average.
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    const outletCriticCount = criticCountByOutlet.get(outletKey) || 1;
    const outletShare = 1 / outletCriticCount;

    // Calculate weighted score (per-outlet share applied so multi-critic outlets
    // sum to one full tier vote)
    const weightedScore = reviewScore * tierWeight * confidenceWeight * outletShare;

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
      confidenceWeight,
      weightedScore,
      designation: review.designation,
      quote: review.quote,
      summary: review.summary,
      pullQuote: review.pullQuote,
      originalRating: review.originalRating,
      outletShare,
    };
  });

  // Weighted average using tier weights
  // The denominator must include the same outletShare so the math collapses to a
  // proper outlet-level weighted mean (not an inflated count).
  const weightedSum = computedReviews.reduce((sum, r) => sum + r.weightedScore, 0);
  const totalWeight = computedReviews.reduce(
    (sum, r) => sum + r.tierWeight * r.confidenceWeight * (r.outletShare ?? 1),
    0,
  );
  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;

  const tier1Count = computedReviews.filter(r => r.tier === 1).length;
  const tier2Count = computedReviews.filter(r => r.tier === 2).length;
  const tier3Count = computedReviews.filter(r => r.tier === 3).length;

  return {
    score: weightedScore,
    weightedScore,
    reviewCount: dedupedReviews.length,
    tier1Count,
    tier2Count,
    tier3Count,
    label: getCriticLabel(Math.round(weightedScore)),
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

  // Keep 2 decimal places for tiebreaking in sort order
  const raw = normalizedScores.reduce((sum, s) => sum + s.value * s.weight, 0);
  return Math.round(raw * 100) / 100;
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
  showReviews: RawReview[],
  audienceData: RawAudience[],
  buzzThreads: RawBuzzThread[]
): ComputedShow {
  // Caller is expected to pass reviews already pre-filtered to this show
  // (data-core.ts uses a Map<showId, Reviews[]> index). The inner filter was
  // removed as a no-op once all callers were updated (only data-core.ts:getAllShows).

  // Pre-2005 closed shows: hide reviews entirely (unreliable data from bulk import)
  // Announced shows: never surface a composite score — any reviews present belong
  // to a prior production and would mislead ("upcoming show with 82 score").
  const hideReviews = shouldHideReviews(show) || show.status === 'announced';
  // Include singleModelEmergency reviews in the composite (2026-05-16).
  //
  // Background: when ensemble scoring runs and 2 of 3 models fail (commonly
  // Gemini outage), the surviving model's score is still saved with
  // ensembleData.singleModelEmergency=true. Previously this flag excluded the
  // review from /opera, /off-broadway, /broadway, /west-end list pages — but
  // generate-mobile-show-details.js (which writes /data/shows/*.json) does
  // NOT exclude them. The asymmetry caused stale-looking market pages (e.g.
  // /opera showed Eugene Onegin at 51/2 reviews while the per-show JSON had
  // 60/3 — the missing review was a singleModelEmergency Parterre score).
  //
  // The Phase 4 daily cron in llm-ensemble-score.yml already retries these
  // automatically (singleModelEmergencyRetryCount<1 → re-score; if 2+ models
  // succeed the flag clears; if not, retryCount=1 prevents further retries).
  // So including these in the composite means: low-confidence scores show up
  // briefly until the cron picks them up, instead of disappearing entirely.
  // Notion 362637c5-416f-81ff-ad1f-c5b4b85e62ef tracks the parity question.
  let criticScore = hideReviews ? null : computeCriticScore(showReviews, show.category, (show as { type?: string }).type);

  // V1: composite score = critic score (audience/buzz coming later)
  // Keep 2 decimal places for tiebreaking in sort order (e.g., 87.96 vs 87.12)
  const compositeScore = criticScore?.weightedScore
    ? Math.round(criticScore.weightedScore * 100) / 100
    : null;

  // Build-time status correction: safety net for stale data from concurrent pushes.
  // The source script (update-show-status.js) runs daily, but race conditions between
  // CI runs and local sessions can overwrite status changes.
  // Use market-local date: opening dates are calendar dates in the show's timezone
  // (ET for Broadway/OB, London for WE/OWE). UTC comparison causes off-by-one when
  // builds run after midnight UTC but before midnight local (e.g., Titanique 2026-04-12
  // appeared "open" at 9pm ET April 11 because UTC was already April 12).
  const today = getMarketDate(show.category);
  let normalizedStatus = show.status;
  if (normalizedStatus === 'previews' && show.openingDate && show.openingDate <= today) {
    normalizedStatus = 'open';
  } else if (normalizedStatus === 'open' && show.closingDate && show.closingDate < today) {
    normalizedStatus = 'closed';
  }

  const confidence = assessConfidence(criticScore, null, normalizedStatus);

  // Compute review age note for shows where reviews are from a past year (open shows only)
  let reviewYearNote: string | null = null;
  if (normalizedStatus !== 'closed' && show.openingDate && showReviews.length >= 3) {
    const openYear = new Date(show.openingDate).getFullYear();
    const currentYear = new Date().getFullYear();
    if (currentYear - openYear >= 10) {
      reviewYearNote = `Most reviews from ${openYear}`;
    }
  }

  return {
    id: show.id,
    title: show.title,
    slug: show.slug,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate,
    status: normalizedStatus === 'previews' && show.previewsStartDate && show.previewsStartDate > today ? 'upcoming' : normalizedStatus,
    type: show.type,
    category: show.category,
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
    creativeTeam: show.creativeTeam,
    tags: show.tags,
    theaterAddress: show.theaterAddress,
    // Revival and historical tracking
    isRevival: show.isRevival || (show.type as string) === 'revival' || (show.tags?.includes('revival') ?? false),
    originalProductionId: show.originalProductionId,
    productionNumber: show.productionNumber,
    season: show.season,
    homepageInclude: show.homepageInclude,
    homepageExclude: show.homepageExclude,
    // Scores
    criticScore,
    audienceScore: null,
    buzzScore: null,
    compositeScore,
    confidence,
    reviewYearNote,
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
    designationFloors: DESIGNATION_FLOORS,
    audiencePlatformWeights: AUDIENCE_PLATFORM_WEIGHTS,
    buzzConfig: BUZZ_CONFIG,
    confidenceThresholds: CONFIDENCE_THRESHOLDS,
    divergenceThreshold: AUDIENCE_DIVERGENCE_THRESHOLD,
  };
}
