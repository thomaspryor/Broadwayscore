import { getAllShows } from '@/lib/data-core';
import { isLocalOnlyShow } from '@/lib/local-market';
import { getMarketDate } from '@/lib/date-utils';
import { pickWantShows, pickWelcomeShows, WELCOME_MARKETS, type WelcomeMarket, type WelcomeShow, type WelcomeWantShow } from '@/lib/welcome-onboarding';

// Built once per deploy: the poster grids in the welcome sheet (BRO-4619),
// one per market. A route rather than a public/data file so it needs no
// generator step and is always computed from the same data as the rest of
// the build. `shows` (Broadway) stays for pages loaded before the per-market
// lists existed. `wants` is the second screen's list (BRO-6917 Part 4): the
// best-reviewed shows running now, per market.
export const dynamic = 'force-static';

export async function GET() {
  const sources = getAllShows().filter(s => !isLocalOnlyShow(s)).map(s => ({
    id: s.id,
    title: s.title,
    slug: s.slug,
    status: s.status,
    category: s.category,
    openingDate: s.openingDate,
    closingDate: s.closingDate,
    images: s.images,
    reviewCount: s.criticScore?.reviewCount ?? 0,
    score: s.criticScore?.score ?? null,
  }));
  const markets = Object.fromEntries(WELCOME_MARKETS.map(m => [
    m,
    pickWelcomeShows(sources, getMarketDate(m), { category: m }),
  ])) as Record<WelcomeMarket, WelcomeShow[]>;
  const wants = Object.fromEntries(WELCOME_MARKETS.map(m => [
    m,
    pickWantShows(sources, getMarketDate(m), { category: m }),
  ])) as Record<WelcomeMarket, WelcomeWantShow[]>;
  return Response.json({ shows: markets.broadway, markets, wants });
}
