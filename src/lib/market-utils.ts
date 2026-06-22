/**
 * Market utility functions — single source of truth for market properties.
 * No data imports — safe for client components.
 * For venue classification (requires data/west-end-venues.json), use venue-classification.ts.
 */

export type ShowCategory = 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end' | 'regional';

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
export function isLondonMarket(category?: string): boolean {
  return category === 'west-end' || category === 'off-west-end';
}

/** Returns true for off-broadway and off-west-end — smaller venue markets. */
export function isOffMarket(category?: string): boolean {
  return category === 'off-broadway' || category === 'off-west-end';
}

/** Minimum reviews threshold for a market: 3 for London/Off-Broadway/Regional, 5 for Broadway. */
export function getMarketMinReviews(category?: string): number {
  return isLondonMarket(category) || category === 'off-broadway' || category === 'regional' ? 3 : 5;
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
