import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { getShowGrosses, getGrossesWeekEnding, getGrossesLastUpdated } from '@/lib/data-grosses';
import { generateBreadcrumbSchema, BASE_URL, SITE_OG_IMAGE } from '@/lib/seo';
import { ThisWeekTable, AllTimeTable } from '@/components/SortableBoxOfficeTable';
import { featureFlags } from '@/config/feature-flags';
import { getBoxOfficeMarketPage } from '@/lib/data-commercial';
import { thisWeekRows } from '@/lib/box-office-this-week';
import MarketOverview from '@/components/box-office/MarketOverview';
import { MarketMovers, PerSeatRanking, Standouts, PriceMapSection } from '@/components/box-office/MarketStories';
import NewMusicalsChart from '@/components/box-office/NewMusicalsChart';
import PriceMapLazy from '@/components/box-office/PriceMapLazy';
// Unreleased (BRO-5007): a client loader, so the tables are their own chunk and a flag-off page never fetches them.
import BoxOfficeV2Tables from '@/components/BoxOfficeV2TablesLazy';
import { DataStalenessBanner } from '@/components/show-cards';


export const metadata: Metadata = {
  title: 'Box Office Scorecard - Broadway Weekly Grosses & Stats',
  description: 'Complete Broadway box office data: weekly grosses, capacity percentages, average ticket prices, and all-time statistics for every show currently playing.',
  alternates: {
    canonical: `${BASE_URL}/box-office`,
  },
  openGraph: {
    images: [SITE_OG_IMAGE],
    title: 'Box Office Scorecard - Broadway Weekly Grosses',
    description: 'Weekly grosses, capacity, and all-time box office stats for every Broadway show.',
    url: `${BASE_URL}/box-office`,
    type: 'article',
  },
};

// FAQ Schema for AI optimization
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the highest-grossing Broadway show this week?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The highest-grossing Broadway shows typically include long-running hits like Wicked, The Lion King, and Hamilton, which regularly gross over $2 million per week. Check our weekly updated leaderboard for current rankings.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the highest-grossing Broadway show of all time?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Lion King is the highest-grossing Broadway show of all time, having earned over $2 billion on Broadway alone since opening in 1997. Wicked and Hamilton are also among the top grossers.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where does Broadway box office data come from?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway box office data is reported weekly by The Broadway League and published by outlets like BroadwayWorld. Data is typically released on Mondays or Tuesdays for the week ending the previous Sunday.',
      },
    },
  ],
};

export default function BoxOfficePage() {
  const allShows = getBroadwayShows();
  const weekEnding = getGrossesWeekEnding();
  const lastUpdated = getGrossesLastUpdated();

  // Get shows with grosses data, sorted by this week's gross
  // Include any show with thisWeek data (not just 'open' — shows that closed during
  // the reporting week still have valid grosses for that week)
  const showsWithGrosses = thisWeekRows(allShows, getShowGrosses);

  // Get all-time leaders (including closed shows). The source table has one row
  // per title, but a title's row can sit on two productions (Mamma Mia! 2001 and
  // 2025, Chicago 1975 and 1996, BRO-5012); list each title once, highest first.
  const seenAllTime = new Set<string>();
  const allTimeLeaders = allShows
    .map(show => ({
      show,
      grosses: getShowGrosses(show.slug),
    }))
    .filter(item => item.grosses?.allTime?.gross)
    .sort((a, b) => (b.grosses?.allTime?.gross || 0) - (a.grosses?.allTime?.gross || 0))
    .filter(item => {
      const key = item.show.title.trim().toLowerCase();
      if (seenAllTime.has(key)) return false;
      seenAllTime.add(key);
      return true;
    })
    .slice(0, 10);

  // Box Office v3 market page (unreleased): computed only when both flags are on.
  const market = featureFlags.commercial && featureFlags.boxOfficeV2 ? getBoxOfficeMarketPage() : null;
  // v3 lists every show that reported this week, previews included.
  const marketWeekRows = market ? thisWeekRows(allShows, getShowGrosses, new Set(Object.keys(market.table))) : showsWithGrosses;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Box Office', url: `${BASE_URL}/box-office` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Box Office</h1>
          <p className="text-gray-400 mt-2">
            {market
              ? 'What Broadway sold this week, which shows are really in demand, and how the new ones compare.'
              : 'Weekly grosses and all-time statistics for every Broadway show.'}
          </p>
          <p className="text-sm text-fg-muted mt-1">
            Week ending {weekEnding} · {market ? 'Broadway League figures' : <>Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>}
          </p>
        </div>
        <DataStalenessBanner lastUpdated={lastUpdated} weekEnding={weekEnding} kind="grosses" market="broadway" />

        {market ? (
          <>
            <MarketOverview page={market} />
            <MarketMovers movers={market.movers} />
            <PerSeatRanking perSeat={market.perSeat} />
            <Standouts page={market} />
            <PriceMapSection dots={market.priceMap.length}>
              <PriceMapLazy dots={market.priceMap} groups={market.priceMapPhone} />
            </PriceMapSection>
            <NewMusicalsChart cohort={market.cohort} />
            <BoxOfficeV2Tables thisWeek={marketWeekRows} allTime={allTimeLeaders} extra={market.table} />
          </>
        ) : (
          <>
          {/* This Week Leaderboard */}
          <section className="mb-12">
            <h2 className="text-xl font-bold text-white mb-4">This Week&apos;s Top Grossers</h2>
            <p className="text-gray-400 text-sm mb-4">
              Click any column header to sort. Shows are ranked by weekly gross by default.
            </p>
            <ThisWeekTable data={showsWithGrosses} />
            <p className="text-xs text-fg-muted mt-3">
              <span aria-hidden="true">*</span> Capacity above 100% reflects extra performances or premium pricing reported by The Broadway League.
            </p>
          </section>

          {/* All-Time Leaders */}
          <section className="mb-12">
            <h2 className="text-xl font-bold text-white mb-4">All-Time Box Office Leaders</h2>
            <p className="text-gray-400 text-sm mb-4">
              Cumulative Broadway gross over entire run. The Lion King holds the all-time record at over $2 billion.
            </p>
            <AllTimeTable data={allTimeLeaders} />
          </section>
          </>
        )}

        {/* Data Source Note */}
        <div className="text-sm text-fg-muted border-t border-white/5 pt-6">
          <p>
            Box office data sourced from BroadwayWorld, which aggregates official figures from The Broadway League.
            Updated weekly after the reporting period ends.
          </p>
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
            Learn more about our data sources →
          </Link>
        </div>
      </div>
    </>
  );
}
