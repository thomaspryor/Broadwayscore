/**
 * Site-side reader for src/config/markets.json (BRO-4211), the one table of
 * show categories. Mirrors scripts/lib/markets.js, which reads
 * NEXT_PUBLIC_FEATURES directly because it runs in prebuild.
 */

import markets from '@/config/markets.json';
import { featureFlags } from '@/config/feature-flags';

interface MarketRow {
  label: string;
  market: string;
  minReviews: number;
  featureFlag: string | null;
  /** Web flag switched on in code (the featureFlags getter returns true). */
  launched?: boolean;
  hideFromAppFeed: boolean;
}

export const MARKETS = markets.categories as Record<string, MarketRow>;

/**
 * True when a show of this category may appear on public surfaces (detail
 * pages, OG images, sitemap, search). Only categories that declare a
 * featureFlag are ever hidden.
 */
export function isCategoryEnabled(category?: string | null): boolean {
  const flag = category ? MARKETS[category]?.featureFlag : null;
  if (!flag) return true;
  return Boolean((featureFlags as unknown as Record<string, boolean>)[flag]);
}
