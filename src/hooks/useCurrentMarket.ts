'use client';

import { usePathname } from 'next/navigation';

export type MarketId = 'nyc' | 'west-end' | 'off-west-end' | 'off-broadway' | 'regional';

/**
 * Detects the current market from the URL pathname.
 * Handles both browse pages (/west-end, /off-west-end) and
 * show detail pages (/show/hamilton-west-end-2021).
 */
export function useCurrentMarket(): MarketId {
  const pathname = usePathname();
  return getMarketFromPath(pathname);
}

export function getMarketFromPath(pathname: string): MarketId {
  // Direct market pages
  if (pathname.startsWith('/off-west-end')) return 'off-west-end';
  if (pathname.startsWith('/west-end')) return 'west-end';
  if (pathname.startsWith('/off-broadway')) return 'off-broadway';
  // WE-specific pages outside the /west-end/ prefix
  if (pathname.startsWith('/olivier-awards')) return 'west-end';

  // Show detail pages: /show/{slug} where slug contains market suffix
  // Slugs may end with market (hamilton-west-end) or have year (hamilton-west-end-2021)
  if (pathname.startsWith('/show/')) {
    const slug = pathname.slice(6); // remove '/show/'
    // Check off-west-end before west-end (longer match first)
    if (slug.includes('-off-west-end')) return 'off-west-end';
    if (slug.includes('-west-end')) return 'west-end';
    if (slug.includes('-off-broadway')) return 'off-broadway';
    if (slug.includes('-regional')) return 'regional';
  }

  return 'nyc';
}

/** Returns true for west-end or off-west-end */
export function isLondonPath(pathname: string): boolean {
  const m = getMarketFromPath(pathname);
  return m === 'west-end' || m === 'off-west-end';
}
