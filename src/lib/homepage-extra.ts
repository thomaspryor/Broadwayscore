// Server-only data for the homepage's deferred payload (BRO-6278).
//
// The shelves below the fold, the Off-Broadway/West End search entries and the
// card fields they need used to be inlined in the homepage's RSC flight data
// (about 300kB of the 660kB HTML). None of it renders before the shelves scroll
// into view or the visitor searches, so src/app/homepage-extra.json/route.ts now
// serves it as a static file and HomePageClient fetches it on demand.
import fs from 'fs';
import path from 'path';
import { featureFlags } from '@/config/feature-flags';
import { pickRegionalShelf } from '@/lib/regional-shelf';
import { getBroadwayShows, getOffBroadwayShows, getWestEndShows, getOperaShows, getRegionalShows, getNYTCriticsPickShowIds, getTourShows } from '@/lib/data-core';
import { getTourNowNextForShow } from '@/lib/data-tour-schedule';
import { shortCity } from '@/lib/tour-schedule';
import type { ComputedShow } from '@/lib/data-types';
import { createShowSerializer } from '@/lib/serialize-show';
import { hasEnoughReviews } from '@/config/score-buckets';
import type { HomepageShow, FeaturedRowData } from '@/components/HomePageClient';
import { formatShowDate } from '@/lib/date-utils';
import { displaysCriticScore } from '@/lib/critic-score-display';

export interface HomepageExtra {
  featuredRows: FeaturedRowData[];
  offBroadwayShows: HomepageShow[];
  westEndShows: HomepageShow[];
}

export function buildHomepageExtra(): HomepageExtra {
  const serialize = createShowSerializer();
  function serializeShow(show: ComputedShow): HomepageShow {
    return serialize(show) as HomepageShow;
  }
  const allShows = getBroadwayShows();
  const obShows = getOffBroadwayShows().filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    s.type !== 'opera' && // opera gets its own "At the Met" shelf
    displaysCriticScore(s)
  );
  // Active West End shows only. These feed homepage search alone, and closed
  // ones come from the lazy public/data/west-end-archive.json
  // (scripts/generate-west-end-archive.js). Inlining closed shows let the West
  // End historical backfill grow this page by ~2.7KB per show (BRO-4872).
  const weShows = getWestEndShows().filter(s =>
    s.status !== 'closed' &&
    s.criticScore?.score != null && hasEnoughReviews(
      s.criticScore.reviewCount ?? 0, s.category,
      (s.criticScore.tier1Count ?? 0) + (s.criticScore.tier2Count ?? 0),
    )
  );
  // Opera shelf: small universe (typically 3-4 Met productions running concurrently),
  // so the reviewCount threshold is lower than OB (5) / WE (3). Currently-running
  // productions only — the /opera page shows the full archive including closed runs.
  const operaShelfShows = getOperaShows().filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    s.criticScore && s.criticScore.score && s.criticScore.reviewCount !== undefined && s.criticScore.reviewCount >= 2
  );

  // Pre-Broadway tryouts shelf: regional feeder-venue productions (auto-tracked
  // from aggregator roundups). Small universe like opera; tryouts are limited
  // runs so CLOSED shows stay on the shelf (the score is the point — it's the
  // pre-Broadway signal), running productions first, then most recent.
  const regionalShelfShows = pickRegionalShelf(getRegionalShows(), { requireEnoughReviews: true });

  // Pre-compute ALL featured rows server-side to avoid 700+ item iterations on client hydration
  const tonyWinnersShows = allShows
    .filter(s => s.status === 'open' && s.tags?.some(t => t.toLowerCase() === 'tony-winner'))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  const dateNightShowsList = allShows
    .filter(s => {
      if (s.status !== 'open') return false;
      const tags = s.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = s.ageRecommendation?.toLowerCase() || '';
      return (tags.includes('romantic') || tags.includes('drama')) && !ageRec.includes('ages 6') && !ageRec.includes('ages 8');
    })
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  const kidsShowsList = allShows
    .filter(s => {
      if (s.status !== 'open') return false;
      const tags = s.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = s.ageRecommendation?.toLowerCase() || '';
      return tags.includes('family') || tags.includes('accessible') || ageRec.includes('ages 6') || ageRec.includes('ages 8') || ageRec.includes('all ages');
    })
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  const now = new Date();
  const shortDate = (d: string) => formatShowDate(d, { month: 'short', day: 'numeric' });

  const closingSoonShowsList = allShows
    .filter(s => {
      if (s.status !== 'open' || !s.closingDate) return false;
      const closing = new Date(s.closingDate);
      const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays > 0 && diffDays <= 120;
    })
    .sort((a, b) => new Date(a.closingDate!).getTime() - new Date(b.closingDate!).getTime())
    .map(s => ({ ...serializeShow(s), subtitle: `Closes ${shortDate(s.closingDate!)}`, subtitleColor: 'text-amber-400' }));

  const jukeboxMusicalsList = allShows
    .filter(s => s.status === 'open' && s.tags?.some(t => t.toLowerCase() === 'jukebox'))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  const bestOffBroadwayList = obShows
    .filter(s => s.criticScore?.score && hasEnoughReviews(
      s.criticScore.reviewCount ?? 0, s.category,
      (s.criticScore.tier1Count ?? 0) + (s.criticScore.tier2Count ?? 0)
    ))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  // --- New shelves: Previews, Lotteries, Rush, Box Office, Sold Out, West End ---

  // Lottery/Rush data (fallback to empty if file missing)
  let lrShows: Record<string, { lottery?: { price?: number }; specialLottery?: { price?: number }; rush?: { price?: number }; digitalRush?: { price?: number } }> = {};
  try {
    const lotteryRushData = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data/lottery-rush.json'), 'utf8')
    );
    lrShows = lotteryRushData.shows || {};
  } catch { /* lottery-rush.json missing — shelves will be empty */ }

  function lotterySubtitle(showId: string): string | undefined {
    const lr = lrShows[showId];
    if (!lr) return undefined;
    const price = lr.specialLottery?.price ?? lr.lottery?.price;
    return price ? `$${Math.round(price)} lottery` : undefined;
  }

  function rushSubtitle(showId: string): string | undefined {
    const lr = lrShows[showId];
    if (!lr) return undefined;
    const prices = [lr.rush?.price, lr.digitalRush?.price].filter((p): p is number => p != null);
    const price = prices.length ? Math.min(...prices) : undefined;
    return price ? `$${Math.round(price)} rush` : undefined;
  }

  // Broadway Lotteries — open BW shows with lottery, sorted by score
  const lotteryShowsList = allShows
    .filter(s => s.status === 'open' && lrShows[s.id]?.lottery)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(s => ({ ...serializeShow(s), subtitle: lotterySubtitle(s.id) }));

  // Rush Tickets — open BW shows with rush or digital rush, sorted by score
  const rushShowsList = allShows
    .filter(s => s.status === 'open' && (lrShows[s.id]?.rush || lrShows[s.id]?.digitalRush))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(s => ({ ...serializeShow(s), subtitle: rushSubtitle(s.id) }));

  // Box Office data (fallback to empty if file missing)
  let grossesShows: Record<string, { thisWeek?: { gross?: number; capacity?: number } }> = {};
  try {
    const grossesData = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data/grosses.json'), 'utf8')
    );
    grossesShows = grossesData.shows || {};
  } catch { /* grosses.json missing — shelves will be empty */ }

  // Top Box Office This Week — sorted by weekly gross (highest first)
  const formatGross = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1_000)}K`;
  const topBoxOfficeList = allShows
    .filter(s => s.status === 'open' && grossesShows[s.slug]?.thisWeek?.gross)
    .sort((a, b) => (grossesShows[b.slug]?.thisWeek?.gross || 0) - (grossesShows[a.slug]?.thisWeek?.gross || 0))
    .map(s => ({ ...serializeShow(s), subtitle: formatGross(grossesShows[s.slug]!.thisWeek!.gross!), subtitleColor: 'text-gray-400' }));

  // Most Sold Out — sorted by capacity % (highest first)
  const mostSoldOutList = allShows
    .filter(s => s.status === 'open' && grossesShows[s.slug]?.thisWeek?.capacity)
    .sort((a, b) => (grossesShows[b.slug]?.thisWeek?.capacity || 0) - (grossesShows[a.slug]?.thisWeek?.capacity || 0))
    .map(s => ({ ...serializeShow(s), subtitle: `${Math.round(grossesShows[s.slug]!.thisWeek!.capacity!)}% capacity`, subtitleColor: 'text-gray-400' }));

  // Shows Starting Soon — in previews or announced-but-not-yet-in-previews,
  // sorted by next milestone date (previews shows by opening date, upcoming shows by previews start date)
  const startingSoonList = allShows
    .filter(s => s.status === 'previews' || (s.status === 'upcoming' && (s.previewsStartDate || s.openingDate)))
    .sort((a, b) => {
      const aDate = a.status === 'previews' ? (a.openingDate || '2099-01-01') : (a.previewsStartDate || a.openingDate);
      const bDate = b.status === 'previews' ? (b.openingDate || '2099-01-01') : (b.previewsStartDate || b.openingDate);
      return new Date(aDate).getTime() - new Date(bDate).getTime();
    })
    .map(s => {
      if (s.status === 'previews') {
        return { ...serializeShow(s), subtitle: s.openingDate ? `Opens ${shortDate(s.openingDate)}` : undefined, subtitleColor: 'text-gray-400' };
      }
      const startDate = s.previewsStartDate || s.openingDate;
      return { ...serializeShow(s), subtitle: startDate ? `Starts ${shortDate(startDate)}` : undefined, subtitleColor: 'text-gray-400' };
    });

  // At the Met — currently-running opera productions with scores, sorted by score
  const bestOperaList = operaShelfShows
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  // Best of the West End — open WE shows with scores, sorted by score
  const bestWestEndList = weShows
    .filter(s => s.status === 'open' && s.criticScore?.score)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow);

  // NYT Critic's Picks — sourced from the authoritative spotlight page
  const nytPickIds = getNYTCriticsPickShowIds();
  const nytCriticsPicksList = nytPickIds.size > 0 ? allShows
    .filter(s => s.status === 'open' && nytPickIds.has(s.id))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(serializeShow) : [];

  const preBroadwayList = featureFlags.regional ? regionalShelfShows.map(serializeShow) : [];

  // On Tour Now (BRO-4757): running national tours that have a score (listed
  // tours only, BRO-4262), best first, with the city they play this week (or
  // the next one, between engagements).
  // New York date: a UTC date flips to tomorrow at 8pm ET.
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const onTourList = featureFlags.tour ? getTourShows()
    .filter(s => s.status === 'open' && s.criticScore?.score)
    .sort((a, b) => ((b.criticScore?.score || 0) - (a.criticScore?.score || 0)) || a.title.localeCompare(b.title))
    .slice(0, 10)
    .map(s => {
      const nn = getTourNowNextForShow(s, today);
      const subtitle = nn?.now ? `Now in ${shortCity(nn.now.city)}`
        : nn?.next ? `Next: ${shortCity(nn.next.city)}` : undefined;
      return { ...serializeShow(s), subtitle, subtitleColor: 'text-gray-400' };
    }) : [];

  const featuredRows: FeaturedRowData[] = [
    { title: 'Best Off-Broadway', shows: bestOffBroadwayList, viewAllHref: '/off-broadway' },
    // Opera shelf \u2014 Met universe is small (3-4 productions running), so minCount 2.
    // Positioned right after Off-Broadway so opera coverage is visible without
    // scrolling past 3 sections (acceptance criterion on Notion 362637c5-416f-8183).
    { title: 'At the Met', shows: bestOperaList, viewAllHref: '/opera', minCount: 2 },
    ...(nytCriticsPicksList.length > 0 ? [{ title: "New York Times Critic\u2019s Picks", shows: nytCriticsPicksList, viewAllHref: '/critics/outlets/the-new-york-times' }] : []),
    { title: 'Broadway Lotteries', shows: lotteryShowsList, viewAllHref: '/lotteries' },
    { title: 'Rush Tickets Available', shows: rushShowsList, viewAllHref: '/rush' },
    { title: 'Top Box Office This Week', shows: topBoxOfficeList, viewAllHref: '/box-office' },
    { title: 'Most Sold Out', shows: mostSoldOutList, viewAllHref: '/box-office' },
    // Time-sensitive (previews/opening-soon) — keep near the top. Moved to
    // second-from-bottom in #825, owner asked to move it back here (#966,
    // 2026-10-02): burying it below evergreen shelves undersells shows that
    // just opened for sale.
    { title: 'Shows Starting Soon', shows: startingSoonList, viewAllHref: '/browse/upcoming-broadway-shows', minCount: 1 },
    { title: 'Best of the West End', shows: bestWestEndList, viewAllHref: '/west-end' },
    // Pre-Broadway tryouts — differentiating coverage nobody else aggregates;
    // lower-shelf placement per user (2026-07-12). Closed tryouts included by
    // design (the score IS the pre-Broadway signal). Spread-gated on the
    // regional flag so a flag-off build emits nothing (not even the row title
    // in the RSC payload) — the /browse page and /show pages 404 when off.
    ...(featureFlags.regional ? [{ title: 'Pre-Broadway: Out-of-Town Shows', shows: preBroadwayList, viewAllHref: '/browse/pre-broadway-out-of-town-shows', minCount: 2 }] : []),
    { title: 'Tony Winning Shows', shows: tonyWinnersShows, viewAllHref: '/browse/tony-winners-on-broadway' },
    { title: 'Perfect for Date Night', shows: dateNightShowsList, viewAllHref: '/browse/broadway-shows-for-date-night' },
    { title: 'Great for Kids', shows: kidsShowsList, viewAllHref: '/guides/best-broadway-shows-for-kids' },
    { title: 'Jukebox Musicals', shows: jukeboxMusicalsList, viewAllHref: '/browse/jukebox-musicals-on-broadway' },
    // Near the bottom per owner (BRO-4757, 2026-10-05).
    ...(featureFlags.tour ? [{ title: 'On Tour Now', shows: onTourList, viewAllHref: '/browse/broadway-national-tours' }] : []),
    { title: 'Closing Soon', shows: closingSoonShowsList, viewAllHref: '/guides/broadway-shows-closing-soon' },
  ];

  return {
    featuredRows,
    offBroadwayShows: obShows.map(serializeShow),
    westEndShows: weShows.map(serializeShow),
  };
}
