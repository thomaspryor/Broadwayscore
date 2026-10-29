import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { getWestEndShows, getUkRegionalShows, getMarketStats } from '@/lib/data-core';
import { SHELF_MAX_ITEMS } from '@/lib/market-list-window';
import { getAwardWinnerSets } from '@/lib/data-awards';
import { pickRegionalShelf } from '@/lib/regional-shelf';
import { getUkRegionalVenueCity } from '@/lib/market-utils';
import { createShowSerializer } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { hasEnoughReviews } from '@/config/score-buckets';
import WestEndPageClient from '@/components/WestEndPageClient';
import type { WestEndShow } from '@/components/WestEndPageClient';
import FeaturedRowServer from '@/components/FeaturedRowServer';
import { featureFlags } from '@/config/feature-flags';
import { displaysCriticScore } from '@/lib/critic-score-display';

export const metadata: Metadata = {
  title: {
    absolute: 'West End Scorecard - London Theatre Ratings & Reviews',
  },
  description: 'CriticScore ratings for London West End shows. See which musicals and plays are getting the best reviews from UK theatre critics.',
  alternates: {
    canonical: `${BASE_URL}/west-end`,
  },
  openGraph: {
    title: 'West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    url: `${BASE_URL}/west-end`,
    type: 'article',
    images: [{ url: `${BASE_URL}/og/west-end.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    images: [`${BASE_URL}/og/west-end.png`],
  },
};

export default function WestEndPage() {
  if (!featureFlags.westEnd) {
    notFound();
  }

  // Memoized per-render: shows repeat across the main grid, Top Musicals shelf,
  // and Lottery/Rush shelves. Sharing one serialized reference per show lets the
  // RSC flight serializer dedupe repeat occurrences (#965).
  const serialize = createShowSerializer();
  function serializeShow(show: ReturnType<typeof getWestEndShows>[number]): WestEndShow {
    return serialize(show, {
      isOffWestEnd: show.category === 'off-west-end',
      category: (show.category as string) || 'west-end',
      slim: true,
    }) as WestEndShow;
  }

  // getWestEndShows() already returns both WE + OWE shows
  const shows = getWestEndShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
  ]);

  // SEO schema excludes previews/upcoming (they have no scores)
  const itemListSchema = generateItemListSchema(
    // Open shows only: closed seasons stay reachable via the sitemap and show pages (BRO-5991).
    shows.filter(s => s.status === 'open').map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score && displaysCriticScore(show) ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      startDate: show.openingDate,
      endDate: show.closingDate,
      status: show.status,
      category: show.category || 'west-end',
    })),
    'West End Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  // Lottery/Rush data
  let lrShows: Record<string, { lottery?: { price?: number }; specialLottery?: { price?: number }; rush?: { price?: number }; digitalRush?: { price?: number } }> = {};
  try {
    const lrData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/lottery-rush.json'), 'utf8'));
    lrShows = lrData.shows || {};
  } catch { /* lottery-rush.json missing */ }

  // Scored shows + upcoming/previews + shows with LR data
  const scoredShows = shows.filter(s => s.criticScore && s.criticScore.reviewCount >= 1);
  const allRelevantShows = shows.filter(s =>
    (s.criticScore && s.criticScore.reviewCount >= 1) ||
    s.status === 'upcoming' || s.status === 'previews' ||
    lrShows[s.id]
  );
  // Closed shows ride west-end-archive.json (lazy-loaded by the client), not the
  // page props, to keep the document small (BRO-5991).
  const serializedShows = allRelevantShows.filter(s => s.status !== 'closed').map(serializeShow);
  const archiveHash = crypto
    .createHash('md5')
    .update(fs.readFileSync(path.join(process.cwd(), 'public/data/west-end-archive.json')))
    .digest('hex')
    .slice(0, 8);

  // Beyond London (BRO-5103): scored productions at flagship UK houses outside
  // London (RSC, Chichester, ...). Live ones first, then most recent. Gated on
  // the regional flag because their detail pages are.
  const beyondLondonShows = featureFlags.regional
    ? pickRegionalShelf(getUkRegionalShows(), { requireEnoughReviews: true })
        .map(s => ({
          ...(serialize(s, { isOffWestEnd: false, category: 'regional', slim: true }) as WestEndShow),
          // The card has no market pill, so name the city under the title.
          subtitle: getUkRegionalVenueCity(s.category, s.venue),
          subtitleColor: 'text-gray-400',
        }))
    : [];
  const beyondLondonShelf = beyondLondonShows.slice(0, SHELF_MAX_ITEMS);

  // WE Lottery/Rush shelves
  const lotteryShowsList = shows
    .filter(s => (s.status === 'open' || s.status === 'previews') && lrShows[s.id]?.lottery)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(s => {
      const price = lrShows[s.id]?.specialLottery?.price ?? lrShows[s.id]?.lottery?.price;
      return { ...serializeShow(s), subtitle: price ? `£${price} lottery` : undefined, subtitleColor: 'text-emerald-400' };
    })
    .slice(0, SHELF_MAX_ITEMS);

  const rushShowsList = shows
    .filter(s => (s.status === 'open' || s.status === 'previews') && (lrShows[s.id]?.rush || lrShows[s.id]?.digitalRush))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .map(s => {
      const prices = [lrShows[s.id]?.rush?.price, lrShows[s.id]?.digitalRush?.price].filter((p): p is number => p != null);
      const price = prices.length ? Math.min(...prices) : undefined;
      return { ...serializeShow(s), subtitle: price ? `£${price} rush` : undefined, subtitleColor: 'text-emerald-400' };
    })
    .slice(0, SHELF_MAX_ITEMS);

  // Count reviews across all scored shows (WE + OWE)
  const totalReviews = scoredShows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  // Open-show counts for the market pills (sourced from getMarketStats)
  const stats = getMarketStats();
  const marketOpenCounts = {
    westEnd: stats.westEnd.openShows,
    offWestEnd: stats.offWestEnd?.openShows ?? 0,
  };

  // Top Musicals shelf — computed here (not in the client) so the LCP poster
  // lands in the static HTML. The client renders `skipAboveFold` to avoid a
  // duplicate. Mirrors the client's topMusicals predicate exactly (#317).
  const weHasEnoughReviews = (s: WestEndShow) => hasEnoughReviews(
    s.criticScore?.reviewCount ?? 0,
    s.category || 'west-end',
    (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0),
  );
  const topMusicals = serializedShows
    .filter(s => s.type === 'musical' && s.status === 'open' && s.criticScore?.score && weHasEnoughReviews(s))
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));

  // Preload the first few posters so the LCP image starts downloading early.
  const preloadPosterUrls = topMusicals
    .slice(0, 4)
    .map(s => {
      const img = s.images?.poster || s.images?.thumbnail || s.images?.hero;
      return img ? getOptimizedImageUrl(img, 'card') : null;
    })
    .filter((u): u is string => !!u);

  return (
    <>
      {preloadPosterUrls.map((url, i) => (
        <link key={`preload-${i}`} rel="preload" as="image" href={url} fetchPriority={i === 0 ? 'high' : undefined} />
      ))}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      {/* Server-rendered hero + Top Musicals shelf — LCP image appears in the
          initial HTML, no JS needed. The client below renders skipAboveFold. */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-5 sm:pt-12">
        <div className="mb-4 sm:mb-8">
          <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
            WestEnd<span className="bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-pink-400 border border-pink-400/30 bg-pink-400/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl">
            Every show. Every review. One score.
          </p>
          <p className="text-fg-muted text-sm sm:text-base mt-1">
            {scoredShows.length} scored shows. {totalReviews.toLocaleString()} critic reviews. And counting.
          </p>
        </div>
        {topMusicals.length > 0 && (
          <FeaturedRowServer shows={topMusicals.slice(0, SHELF_MAX_ITEMS)} title="Top Musicals" subtitle="Ranked by critical consensus" />
        )}
      </div>

      <Suspense>
        <WestEndPageClient
          renderedAt={Date.now()}
          shows={serializedShows}
          totalShows={scoredShows.length}
          totalReviews={totalReviews}
          scoredShows={scoredShows.length}
          lotteryShows={lotteryShowsList}
          rushShows={rushShowsList}
          beyondLondonShows={beyondLondonShelf}
          marketOpenCounts={marketOpenCounts}
          awardWinnerSets={getAwardWinnerSets()}
          archiveHash={archiveHash}
          skipAboveFold
        />
      </Suspense>
    </>
  );
}
