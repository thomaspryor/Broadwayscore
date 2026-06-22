/**
 * Score Bucket Configuration
 *
 * Defines the score ranges and their visual presentation.
 * Used for displaying score badges and filtering shows.
 */

import type { ScoreBucket } from '@/types/canonical';

// ===========================================
// SCORE BUCKET DEFINITIONS
// ===========================================

export interface ScoreBucketConfig {
  id: ScoreBucket;
  label: string;              // Display label
  shortLabel: string;         // Short version for badges
  minScore: number;           // Inclusive minimum
  maxScore: number;           // Inclusive maximum
  color: string;              // Tailwind color class
  bgColor: string;            // Background color class
  description: string;        // Tooltip/explanation
}

export const SCORE_BUCKETS: ScoreBucketConfig[] = [
  {
    id: 'must-see',
    label: 'Critical Gold',
    shortLabel: 'Critical Gold',
    minScore: 83,
    maxScore: 100,
    color: 'text-amber-400',      // Gold
    bgColor: 'bg-amber-400/20',
    description: 'Drop-everything great. If you\'re seeing one show, make it this.',
  },
  {
    id: 'recommended',
    label: 'Recommended',
    shortLabel: 'Recommended',
    minScore: 75,
    maxScore: 82,
    color: 'text-emerald-400',    // Green
    bgColor: 'bg-emerald-400/20',
    description: 'Strong choice—most people will have a great time.',
  },
  {
    id: 'worth-seeing',
    label: 'Worth Seeing',
    shortLabel: 'Worth Seeing',
    minScore: 65,
    maxScore: 74,
    color: 'text-sky-400',        // Blue
    bgColor: 'bg-sky-400/20',
    description: 'Good, with caveats. Best if the premise/cast/genre is your thing.',
  },
  {
    id: 'skippable',
    label: 'Skippable',
    shortLabel: 'Skippable',
    minScore: 55,
    maxScore: 64,
    color: 'text-orange-500',     // Orange (darker, distinct from Must-See gold)
    bgColor: 'bg-orange-500/20',
    description: 'Optional. Fine to miss unless you\'re a completist or super fan.',
  },
  {
    id: 'stay-away',
    label: 'Critical Miss',
    shortLabel: 'Critical Miss',
    minScore: 0,
    maxScore: 54,
    color: 'text-red-400',        // Red
    bgColor: 'bg-red-400/20',
    description: 'Not recommended—save your time and money.',
  },
  {
    id: 'pending',
    label: 'Pending',
    shortLabel: 'TBD',
    minScore: -1,
    maxScore: -1,
    color: 'text-gray-400',       // Gray
    bgColor: 'bg-gray-400/20',
    description: 'Not enough reviews yet',
  },
];

// ===========================================
// MINIMUM REVIEWS FOR SCORE
// ===========================================

/** Minimum number of reviews required to display a score */
export const MIN_REVIEWS_FOR_SCORE = 5;

/** Minimum reviews for off-Broadway (fewer reviews available in the ecosystem) */
export const MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY = 3;

/** Minimum reviews for West End (matches Broadway — UK outlet ecosystem is large enough) */
export const MIN_REVIEWS_FOR_SCORE_WEST_END = 5;

/** Minimum reviews for Off-West End (smaller fringe venues, fewer reviews available) */
export const MIN_REVIEWS_FOR_SCORE_OFF_WEST_END = 3;

/**
 * Curated historical shows qualify with 1 fewer review (4 vs 5 for Broadway)
 * because their universe of recoverable critic coverage is more constrained.
 * Only applies to Broadway; requires at least 1 T1+T2 review.
 */
export const MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL = 4;

/** Extra reviews required when all reviews are T3 (no T1/T2 coverage) */
export const T3_ONLY_EXTRA_REVIEWS = 2;

/** Minimum tier 1 reviews for high confidence */
export const MIN_TIER1_FOR_HIGH_CONFIDENCE = 3;

// ===========================================
// PER-MARKET GOLD THRESHOLD
// ===========================================
// WE star ratings (5-point scale) cluster at 80/100, inflating scores.
// WE Gold requires 85+ vs Broadway's 83+ for a more meaningful distinction.

export const MARKET_GOLD_THRESHOLD: Record<string, number> = {
  'west-end': 85,
  'off-west-end': 85,
};
const DEFAULT_GOLD_THRESHOLD = 83;

/** Get the Critical Gold minimum score for a given market */
export function getGoldThreshold(category?: string): number {
  return MARKET_GOLD_THRESHOLD[category || ''] ?? DEFAULT_GOLD_THRESHOLD;
}

/**
 * Whether a score qualifies as Critical Gold (renders the crown).
 * Uses Math.round to match the displayed value — a raw score of 82.5 displays
 * as "83" with the gold tier color, so the crown gate must agree.
 * Use this everywhere instead of inlining `score >= getGoldThreshold(...)`.
 */
export function isCriticalGold(score: number | null | undefined, category?: string): boolean {
  if (score === null || score === undefined) return false;
  return Math.round(score) >= getGoldThreshold(category);
}

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Get the score bucket for a given score, market-aware for Gold threshold
 */
export function getScoreBucket(score: number | null, category?: string): ScoreBucketConfig {
  if (score === null) {
    return SCORE_BUCKETS.find(b => b.id === 'pending')!;
  }

  const goldMin = getGoldThreshold(category);
  // Must-see uses market-aware threshold; other buckets use static ranges
  if (score >= goldMin) return SCORE_BUCKETS.find(b => b.id === 'must-see')!;
  // Recommended upper bound adjusts with Gold threshold
  if (score >= 75) return SCORE_BUCKETS.find(b => b.id === 'recommended')!;
  if (score >= 65) return SCORE_BUCKETS.find(b => b.id === 'worth-seeing')!;
  if (score >= 55) return SCORE_BUCKETS.find(b => b.id === 'skippable')!;
  return SCORE_BUCKETS.find(b => b.id === 'stay-away')!;
}

/**
 * Get the score bucket ID for a given score
 */
export function getScoreBucketId(score: number | null, category?: string): ScoreBucket {
  return getScoreBucket(score, category).id;
}

/**
 * Get the display label for a score
 */
export function getScoreLabel(score: number | null, category?: string): string {
  return getScoreBucket(score, category).label;
}

/**
 * Get the color class for a score
 */
export function getScoreColor(score: number | null, category?: string): string {
  return getScoreBucket(score, category).color;
}

/**
 * Get the background color class for a score
 */
export function getScoreBgColor(score: number | null, category?: string): string {
  return getScoreBucket(score, category).bgColor;
}

/**
 * Check if a score meets the minimum threshold for display.
 * T3-only shows (no T1/T2 reviews) require extra reviews for qualification.
 */
export function hasEnoughReviews(
  reviewCount: number,
  category?: string,
  tier1And2Count?: number,
  isCuratedHistorical?: boolean,
): boolean {
  return reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) === 0;
}

/**
 * How many more reviews are needed before a score can be displayed.
 * Returns 0 when the show already qualifies. Mirrors `hasEnoughReviews` —
 * if you change the threshold logic, change it here too.
 */
export function reviewsRemainingForScore(
  reviewCount: number,
  category?: string,
  tier1And2Count?: number,
  isCuratedHistorical?: boolean,
): number {
  let min = category === 'off-broadway' ? MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY
    : category === 'off-west-end' ? MIN_REVIEWS_FOR_SCORE_OFF_WEST_END
    : category === 'west-end' ? MIN_REVIEWS_FOR_SCORE_WEST_END
    : category === 'regional' ? MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY
    : MIN_REVIEWS_FOR_SCORE;

  // Curated historical override: only applies to Broadway (the bigger threshold)
  // and requires at least 1 T1+T2 review (so we don't accept e.g. 4 random blogs).
  if (isCuratedHistorical && (!category || category === 'broadway') && (tier1And2Count ?? 0) >= 1) {
    min = MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL;
  }

  if (tier1And2Count !== undefined && tier1And2Count === 0) {
    min += T3_ONLY_EXTRA_REVIEWS;
  }
  return Math.max(0, min - reviewCount);
}

// ===========================================
// CRITIC LABEL THRESHOLDS (for weighted score)
// ===========================================

export const CRITIC_LABEL_THRESHOLDS = {
  Rave: 83,
  Positive: 75,
  Mixed: 55,
  Negative: 0,
} as const;

/**
 * Get the critic consensus label for a score
 */
export function getCriticLabel(score: number): string {
  if (score >= CRITIC_LABEL_THRESHOLDS.Rave) return 'Rave';
  if (score >= CRITIC_LABEL_THRESHOLDS.Positive) return 'Positive';
  if (score >= CRITIC_LABEL_THRESHOLDS.Mixed) return 'Mixed';
  return 'Negative';
}
