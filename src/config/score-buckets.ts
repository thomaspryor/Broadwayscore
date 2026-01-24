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
    label: 'Must See',
    shortLabel: 'Must See',
    minScore: 85,
    maxScore: 100,
    color: 'text-amber-400',      // Gold
    bgColor: 'bg-amber-400/20',
    description: 'Exceptional - a Broadway highlight',
  },
  {
    id: 'great',
    label: 'Great',
    shortLabel: 'Great',
    minScore: 75,
    maxScore: 84,
    color: 'text-emerald-400',    // Green
    bgColor: 'bg-emerald-400/20',
    description: 'Highly recommended',
  },
  {
    id: 'good',
    label: 'Good',
    shortLabel: 'Good',
    minScore: 65,
    maxScore: 74,
    color: 'text-sky-400',        // Blue
    bgColor: 'bg-sky-400/20',
    description: 'Solid show, worth seeing',
  },
  {
    id: 'tepid',
    label: 'Tepid',
    shortLabel: 'Tepid',
    minScore: 55,
    maxScore: 64,
    color: 'text-orange-400',     // Orange
    bgColor: 'bg-orange-400/20',
    description: 'Mixed reviews, consider carefully',
  },
  {
    id: 'skip',
    label: 'Skip',
    shortLabel: 'Skip',
    minScore: 0,
    maxScore: 54,
    color: 'text-red-400',        // Red
    bgColor: 'bg-red-400/20',
    description: 'Generally not recommended',
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

/** Minimum tier 1 reviews for high confidence */
export const MIN_TIER1_FOR_HIGH_CONFIDENCE = 3;

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Get the score bucket for a given score
 */
export function getScoreBucket(score: number | null): ScoreBucketConfig {
  if (score === null) {
    return SCORE_BUCKETS.find(b => b.id === 'pending')!;
  }

  const bucket = SCORE_BUCKETS.find(b =>
    b.id !== 'pending' && score >= b.minScore && score <= b.maxScore
  );

  return bucket || SCORE_BUCKETS.find(b => b.id === 'skip')!;
}

/**
 * Get the score bucket ID for a given score
 */
export function getScoreBucketId(score: number | null): ScoreBucket {
  return getScoreBucket(score).id;
}

/**
 * Get the display label for a score
 */
export function getScoreLabel(score: number | null): string {
  return getScoreBucket(score).label;
}

/**
 * Get the color class for a score
 */
export function getScoreColor(score: number | null): string {
  return getScoreBucket(score).color;
}

/**
 * Get the background color class for a score
 */
export function getScoreBgColor(score: number | null): string {
  return getScoreBucket(score).bgColor;
}

/**
 * Check if a score meets the minimum threshold for display
 */
export function hasEnoughReviews(reviewCount: number): boolean {
  return reviewCount >= MIN_REVIEWS_FOR_SCORE;
}

// ===========================================
// CRITIC LABEL THRESHOLDS (for weighted score)
// ===========================================

export const CRITIC_LABEL_THRESHOLDS = {
  Rave: 85,
  Positive: 70,
  Mixed: 50,
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
