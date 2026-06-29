/**
 * Market utility functions — single source of truth for market properties.
 * No data imports — safe for client components.
 * For venue classification (requires data/west-end-venues.json), use venue-classification.ts.
 */

import {
  MIN_REVIEWS_FOR_SCORE,
  MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY,
  MIN_REVIEWS_FOR_SCORE_WEST_END,
  MIN_REVIEWS_FOR_SCORE_OFF_WEST_END,
} from '@/config/score-buckets';

export type ShowCategory = 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end' | 'regional';

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
export function isLondonMarket(category?: string): boolean {
  return category === 'west-end' || category === 'off-west-end';
}

/** Returns true for off-broadway and off-west-end — smaller venue markets. */
export function isOffMarket(category?: string): boolean {
  return category === 'off-broadway' || category === 'off-west-end';
}

/**
 * Base minimum-reviews threshold for a market. Delegates to the canonical
 * MIN_REVIEWS_FOR_SCORE_* constants in score-buckets.ts so this never drifts
 * from the live list/show-page gate (West End = 5, Off-West End / Off-Broadway /
 * Regional = 3, Broadway = 5). Note: this is the BASE threshold only — the
 * T3-only and curated-historical adjustments live in
 * score-buckets.reviewsRemainingForScore().
 */
export function getMarketMinReviews(category?: string): number {
  switch (category) {
    case 'off-broadway':
    case 'regional':
      return MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY;
    case 'off-west-end':
      return MIN_REVIEWS_FOR_SCORE_OFF_WEST_END;
    case 'west-end':
      return MIN_REVIEWS_FOR_SCORE_WEST_END;
    default:
      return MIN_REVIEWS_FOR_SCORE;
  }
}

/** Country code for a market category. */
export function getMarketCountry(category?: string): 'US' | 'GB' {
  return isLondonMarket(category) ? 'GB' : 'US';
}

/** Currency for a market category. */
export function getMarketCurrency(category?: string): 'USD' | 'GBP' {
  return isLondonMarket(category) ? 'GBP' : 'USD';
}

/** Currency symbol for a market category. */
export function getCurrencySymbol(category?: string): string {
  return isLondonMarket(category) ? '£' : '$';
}

/** Human-readable market label for a category. */
export function getMarketLabel(category?: string): string {
  switch (category) {
    case 'west-end': return 'West End';
    case 'off-west-end': return 'Off-West End';
    case 'off-broadway': return 'Off-Broadway';
    case 'regional': return 'Regional';
    default: return 'Broadway';
  }
}
