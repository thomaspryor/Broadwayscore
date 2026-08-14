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
 * Whether a production has actually reached its stage — previews counts as
 * arrived. Used for regional→Broadway transfer tense (a tryout has
 * "transferred" only once the Broadway run exists; before that it is
 * "transferring"). Single source for the browse sectionGroup, its sort, and
 * the show-page trust line so the tense can never disagree between surfaces.
 */
export function hasReachedStage(status?: string | null): boolean {
  return status === 'previews' || status === 'open' || status === 'closed';
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

// A `category: 'regional'` show can be a US Broadway-feeder (A.R.T., Goodman,
// La Jolla) OR a UK West End-feeder (RSC Stratford, Chichester Festival
// Theatre — added for card #1405, Game of Thrones: The Mad King). The
// category alone can't tell them apart, so country/currency defaulted every
// regional show to 'US'/$ until now — silently wrong for any UK one.
// data/uk-regional-venues.json is the SAME list scripts/lib/aggregator-
// candidate-extract.js's REGIONAL_FEEDER_VENUES draws its UK entries from
// (via the `match` string, word-bounded there) — one source of truth, so
// adding a venue there automatically fixes currency/country here too.
// A plain JSON import is safe in a client bundle: venue-classification.ts's
// isOffWestEndVenue() already does exactly this with west-end-venues.json.
import ukRegionalVenues from '../../data/uk-regional-venues.json';

function isUkRegionalVenue(category?: string, venue?: string): boolean {
  if (category !== 'regional' || !venue) return false;
  const v = venue.toLowerCase();
  return (ukRegionalVenues as { match: string }[]).some((entry) => v.includes(entry.match));
}

/** City for a UK-regional venue (e.g. 'Stratford-upon-Avon' for RSC), from data/uk-regional-venues.json. Undefined for non-UK-regional venues. */
export function getUkRegionalVenueCity(category?: string, venue?: string): string | undefined {
  if (category !== 'regional' || !venue) return undefined;
  const v = venue.toLowerCase();
  return (ukRegionalVenues as { match: string; city: string }[]).find((entry) => v.includes(entry.match))?.city;
}

/** Country code for a market category. `venue` disambiguates UK-regional shows. */
export function getMarketCountry(category?: string, venue?: string): 'US' | 'GB' {
  if (isLondonMarket(category) || isUkRegionalVenue(category, venue)) return 'GB';
  return 'US';
}

/** Currency for a market category. `venue` disambiguates UK-regional shows. */
export function getMarketCurrency(category?: string, venue?: string): 'USD' | 'GBP' {
  if (isLondonMarket(category) || isUkRegionalVenue(category, venue)) return 'GBP';
  return 'USD';
}

/** Currency symbol for a market category. `venue` disambiguates UK-regional shows. */
export function getCurrencySymbol(category?: string, venue?: string): string {
  if (isLondonMarket(category) || isUkRegionalVenue(category, venue)) return '£';
  return '$';
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
