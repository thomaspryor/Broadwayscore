// Official West End theatres (SOLT members / Theatreland).
// Anything NOT on this list is classified as Off-West End.
// Single source of truth: data/west-end-venues.json
import venueList from '../../data/west-end-venues.json';
// Normalizer extracted to src/lib/stats/venue-match.ts so the diary→theater
// matcher and this market gate can never disagree on what a venue name is.
// Its behavior is frozen — see the comment on normalizeVenueKey.
import { normalizeVenueKey } from './stats/venue-match';

// Re-export market utilities for server-side consumers that already import from here
export { isLondonMarket, isOffMarket, getMarketMinReviews, getMarketCountry, getMarketCurrency, getMarketLabel, getUkRegionalVenueCity } from './market-utils';

const WEST_END_VENUES = new Set(venueList as string[]);

export function isOffWestEndVenue(venue?: string): boolean {
  if (!venue || venue === 'TBA') return false;
  return !WEST_END_VENUES.has(normalizeVenueKey(venue));
}
