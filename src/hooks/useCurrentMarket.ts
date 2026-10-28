'use client';

import { usePathname } from 'next/navigation';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { EffectiveMarket } from '@/lib/show-market';

export type MarketId = 'nyc' | 'west-end' | 'off-west-end' | 'off-broadway' | 'regional' | 'uk-regional' | 'tour';
export type ShowMarketOverrides = Readonly<Record<string, EffectiveMarket>>;
const ShowMarketContext = createContext<ShowMarketOverrides>({});

/** Server-provided venue exceptions, available on first render and navigation. */
export function ShowMarketProvider({ showMarkets, children }: { showMarkets: ShowMarketOverrides; children: ReactNode }) {
  return createElement(ShowMarketContext.Provider, { value: showMarkets }, children);
}

/**
 * Detects the current market from the URL pathname.
 * Handles both browse pages (/west-end, /off-west-end) and
 * show detail pages (/show/hamilton-west-end-2021).
 */
export function useCurrentMarket(distinguishUkRegional = false): MarketId {
  const pathname = usePathname();
  const showMarkets = useContext(ShowMarketContext);
  const market = getMarketFromPath(pathname, showMarkets);
  // Search, subscriptions and footer branding belong to the West End family;
  // the navigation pill can request the more specific UK Regional label.
  return market === 'uk-regional' && !distinguishUkRegional ? 'west-end' : market;
}

export function getMarketFromPath(pathname: string, showMarkets: ShowMarketOverrides = {}): MarketId {
  // Direct market pages
  if (pathname.startsWith('/off-west-end')) return 'off-west-end';
  if (pathname.startsWith('/west-end')) return 'west-end';
  if (pathname.startsWith('/off-broadway')) return 'off-broadway';
  // WE-specific pages outside the /west-end/ prefix
  if (pathname.startsWith('/olivier-awards')) return 'west-end';

  // Pre-Broadway browse hub — the market dropdown's regional destination
  if (pathname.startsWith('/browse/pre-broadway-out-of-town-shows')) return 'regional';
  if (pathname === '/browse/beyond-london' || pathname === '/browse/beyond-london/') return 'uk-regional';
  // National tours hub (BRO-4211)
  if (pathname.startsWith('/browse/broadway-national-tours')) return 'tour';

  // Show detail pages: /show/{slug} where slug contains market suffix
  // Slugs may end with market (hamilton-west-end) or have year (hamilton-west-end-2021)
  if (pathname.startsWith('/show/')) {
    const slug = pathname.slice(6).replace(/\/$/, ''); // remove '/show/'
    // Venue-aware overrides come from the server's real show data. The slug
    // alone cannot distinguish UK productions from US regional tryouts.
    const market = showMarkets[slug];
    if (market) return market === 'broadway' ? 'nyc' : market === 'opera' ? 'off-broadway' : market;
    // Check off-west-end before west-end (longer match first)
    if (slug.includes('-off-west-end')) return 'off-west-end';
    if (slug.includes('-west-end')) return 'west-end';
    if (slug.includes('-off-broadway')) return 'off-broadway';
    if (slug.includes('-regional')) return 'regional';
    // Tour ids are "<title>-tour-<year>" (BRO-4211). Anchored so a title that
    // merely contains "tour" (the-apology-tour-off-broadway-2026) is unaffected.
    if (/-tour-\d{4}$/.test(slug)) return 'tour';
  }

  return 'nyc';
}

/** Returns true for west-end or off-west-end */
export function isLondonPath(pathname: string): boolean {
  const m = getMarketFromPath(pathname);
  return m === 'west-end' || m === 'off-west-end' || m === 'uk-regional';
}
