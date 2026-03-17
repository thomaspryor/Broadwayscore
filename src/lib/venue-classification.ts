// Official West End theatres (SOLT members / Theatreland).
// Anything NOT on this list is classified as Off-West End.
// Single source of truth: data/west-end-venues.json
import venueList from '../../data/west-end-venues.json';

const WEST_END_VENUES = new Set(venueList as string[]);

export function isOffWestEndVenue(venue?: string): boolean {
  if (!venue || venue === 'TBA') return false;
  const v = venue.trim().toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
  return !WEST_END_VENUES.has(v);
}

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
export function isLondonMarket(category?: string): boolean {
  return category === 'west-end' || category === 'off-west-end';
}

/** Returns true for off-broadway and off-west-end — smaller venue markets. */
export function isOffMarket(category?: string): boolean {
  return category === 'off-broadway' || category === 'off-west-end';
}

/** Minimum reviews threshold for a market: 3 for London/Off-Broadway, 5 for Broadway. */
export function getMarketMinReviews(category?: string): number {
  return isLondonMarket(category) || category === 'off-broadway' ? 3 : 5;
}

/** Country code for a market category. */
export function getMarketCountry(category?: string): 'US' | 'GB' {
  return isLondonMarket(category) ? 'GB' : 'US';
}

/** Currency for a market category. */
export function getMarketCurrency(category?: string): 'USD' | 'GBP' {
  return isLondonMarket(category) ? 'GBP' : 'USD';
}

/** Human-readable market label for a category. */
export function getMarketLabel(category?: string): string {
  switch (category) {
    case 'west-end': return 'West End';
    case 'off-west-end': return 'Off-West End';
    case 'off-broadway': return 'Off-Broadway';
    default: return 'Broadway';
  }
}
