import { getAllShows } from '@/lib/data-core';
import { getMarketDate } from '@/lib/date-utils';
import { pickWelcomeShows, WELCOME_MARKETS, type WelcomeMarket, type WelcomeShow } from '@/lib/welcome-onboarding';

// Built once per deploy: the poster grids in the welcome sheet (BRO-4619),
// one per market. A route rather than a public/data file so it needs no
// generator step and is always computed from the same data as the rest of
// the build. `shows` (Broadway) stays for pages loaded before the per-market
// lists existed.
export const dynamic = 'force-static';

export async function GET() {
  const sources = getAllShows().map(s => ({
    id: s.id,
    title: s.title,
    slug: s.slug,
    status: s.status,
    category: s.category,
    openingDate: s.openingDate,
    closingDate: s.closingDate,
    images: s.images,
    reviewCount: s.criticScore?.reviewCount ?? 0,
  }));
  const markets = Object.fromEntries(WELCOME_MARKETS.map(m => [
    m,
    pickWelcomeShows(sources, getMarketDate(m), { category: m }),
  ])) as Record<WelcomeMarket, WelcomeShow[]>;
  return Response.json({ shows: markets.broadway, markets });
}
