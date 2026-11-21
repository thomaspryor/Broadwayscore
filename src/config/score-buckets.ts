/**
 * Score Bucket Configuration
 *
 * Defines the score ranges and their visual presentation.
 * Used for displaying score badges and filtering shows.
 */

import type { ScoreBucket } from '@/types/canonical';
import {
  getGoldThreshold, getScoreTierId,
  DEFAULT_GOLD_THRESHOLD, RECOMMENDED_MIN, WORTH_SEEING_MIN, MIXED_MIN,
} from '../../scripts/lib/score-tiers';

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
    minScore: DEFAULT_GOLD_THRESHOLD,
    maxScore: 100,
    color: 'text-amber-400',      // Gold
    bgColor: 'bg-amber-400/20',
    description: 'Drop-everything great. If you\'re seeing one show, make it this.',
  },
  {
    id: 'recommended',
    label: 'Recommended',
    shortLabel: 'Recommended',
    minScore: RECOMMENDED_MIN,
    maxScore: DEFAULT_GOLD_THRESHOLD - 1,
    color: 'text-emerald-400',    // Green
    bgColor: 'bg-emerald-400/20',
    description: 'Strong choice, most people will have a great time.',
  },
  {
    id: 'worth-seeing',
    label: 'Worth Seeing',
    shortLabel: 'Worth Seeing',
    minScore: WORTH_SEEING_MIN,
    maxScore: RECOMMENDED_MIN - 1,
    color: 'text-sky-400',        // Blue
    bgColor: 'bg-sky-400/20',
    description: 'Good, with caveats. Best if the premise/cast/genre is your thing.',
  },
  {
    id: 'skippable',
    label: 'Mixed',
    shortLabel: 'Mixed',
    minScore: MIXED_MIN,
    maxScore: WORTH_SEEING_MIN - 1,
    color: 'text-orange-500',     // Orange (darker, distinct from Must-See gold)
    bgColor: 'bg-orange-500/20',
    description: 'Critics are split: worth a look if the premise grabs you.',
  },
  {
    id: 'stay-away',
    label: 'Critical Miss',
    shortLabel: 'Critical Miss',
    minScore: 0,
    maxScore: MIXED_MIN - 1,
    color: 'text-red-400',        // Red
    bgColor: 'bg-red-400/20',
    description: 'Not recommended: save your time and money.',
  },
  {
    id: 'pending',
    label: 'Pending',
    shortLabel: 'TBD',
    minScore: -1,
    maxScore: -1,
    color: 'text-fg-muted',      // Gray
    bgColor: 'bg-fg-placeholder/20',
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
// The thresholds live ONLY in scripts/lib/score-tiers.js, shared with the app
// feed generator (scripts/generate-mobile-data.js writes cr.l from it) so the
// site badge and the iOS app cannot disagree on a show's tier.
export { MARKET_GOLD_THRESHOLD, getGoldThreshold } from '../../scripts/lib/score-tiers';

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

  // Must-see uses the market-aware threshold; the other tiers use static ranges
  // (scripts/lib/score-tiers.js). Recommended's upper bound moves with Gold.
  const id = getScoreTierId(score, category);
  return SCORE_BUCKETS.find(b => b.id === id)!;
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

// Display gate (hasEnoughReviews / reviewsRemainingForScore): ONE implementation
// in scripts/lib/min-reviews.js, shared with the slim-file generator so the site
// badge and the slim `cs` can't disagree on which shows carry a score (BRO-4312).
// T3-only shows (no T1/T2 reviews) need extra reviews; curated historical
// Broadway shows with a T1/T2 review need only MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL.
export { hasEnoughReviews, reviewsRemainingForScore } from '../../scripts/lib/min-reviews';

// ===========================================
// COVERAGE VERDICT SCORE-REGRESSION FLOOR (S3, task #905)
// ===========================================

// The show page's coverage floor lives in scripts/lib/coverage-floor.js so the
// app feed (cr.pq) applies the same rule; doc comment there.
export { SCORE_REGRESSION_FLOOR_HOURS, applyCoverageFloor } from '../../scripts/lib/coverage-floor';

// ===========================================
// CRITIC LABEL THRESHOLDS (for weighted score)
// ===========================================

export const CRITIC_LABEL_THRESHOLDS = {
  Rave: DEFAULT_GOLD_THRESHOLD,
  Positive: RECOMMENDED_MIN,
  Mixed: MIXED_MIN,
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
