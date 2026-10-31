/**
 * Shared localStorage key constants and helper for Formspree subscription status.
 *
 * Keys:
 *   bsc_email_subscribed           — legacy pre-market-split key (treated as broadway)
 *   bsc_email_subscribed_broadway  — broadway market
 *   bsc_email_subscribed_west-end  — west end market
 */

export const SUBSCRIBED_KEY = 'bsc_email_subscribed';         // Legacy (pre-market-split, broadway)
export const SUBSCRIBED_KEY_PREFIX = 'bsc_email_subscribed_'; // Append market: 'broadway' | 'west-end'

/**
 * Returns true if the user has subscribed via Formspree.
 *
 * - With market: checks that market's specific key; legacy key also counts for broadway.
 * - Without market: checks ALL keys — any match = subscribed (used to suppress banners
 *   for users who subscribed to any market).
 */
export function isFormspreeSubscribed(market?: string): boolean {
  try {
    if (market) {
      return (
        localStorage.getItem(SUBSCRIBED_KEY_PREFIX + market) === 'true' ||
        (market === 'broadway' && localStorage.getItem(SUBSCRIBED_KEY) === 'true')
      );
    }
    // No market: any subscription key = subscribed
    return (
      localStorage.getItem(SUBSCRIBED_KEY) === 'true' ||
      localStorage.getItem(`${SUBSCRIBED_KEY_PREFIX}broadway`) === 'true' ||
      localStorage.getItem(`${SUBSCRIBED_KEY_PREFIX}west-end`) === 'true'
    );
  } catch {
    return false;
  }
}
