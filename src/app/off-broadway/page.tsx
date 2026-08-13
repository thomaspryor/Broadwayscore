import fs from 'fs';
import crypto from 'crypto';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOffBroadwayShows, getNotableOffBroadwayShows, getMarketStats } from '@/lib/data-core';
import { getAwardWinnerSets } from '@/lib/data-awards';
import { createShowSerializer } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import { isRecentlyOpenedAwaitingReviews } from '@/lib/recently-opened';
import { getOptimizedImageUrl } from '@/lib/images';
import { hasEnoughReviews } from '@/config/score-buckets';
import OffBroadwayPageClient from '@/components/OffBroadwayPageClient';
import type { OffBroadwayShow } from '@/components/OffBroadwayPageClient';
import FeaturedRowServer from '@/components/FeaturedRowServer';
import { GoldListCTA } from '@/components/gold-list/GoldListCTA';
import { featureFlags } from '@/config/feature-flags';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: `Best Off-Broadway Shows (${currentYear}) — NYC Reviews & Ratings`,
  description: 'CriticScore ratings for Off-Broadway shows in New York City, aggregated from The New York Times, Vulture, Variety, Time Out, and more.',
  alternates: {
    canonical: `${BASE_URL}/off-broadway`,
  },
  openGraph: {
    title: 'Off-Broadway Scorecard - NYC Show Ratings',
    description: 'Aggregated CriticScore ratings for Off-Broadway shows from The New York Times, Vulture, Variety, and more.',
    url: `${BASE_URL}/off-broadway`,
    type: 'article',
  },
};

export default function OffBroadwayPage() {
  if (!featureFlags.offBroadway) {
    notFound();
  }

  // Memoized per-render: shows repeat across the main grid, Top Recent Shows
  // shelf, Starting Soon, and Just Opened lists. Sharing one serialized
  // reference per show lets the RSC flight serializer dedupe repeat
  // occurrences (#965).
  const serialize = createShowSerializer();
  function serializeShow(show: ReturnType<typeof getOffBroadwayShows>[number]): OffBroadwayShow {
    return serialize(show, { category: 'off-broadway' }) as OffBroadwayShow;
  }

  const shows = getOffBroadwayShows();
  const archiveFile = fs.readFileSync(process.cwd() + '/public/data/off-broadway-archive.json');
  const archiveHash = crypto.createHash('md5').update(archiveFile).digest('hex').slice(0, 8);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-Broadway', url: `${BASE_URL}/off-broadway` },
  ]);

  // SEO schema excludes previews/upcoming (they have no scores)
  const itemListSchema = generateItemListSchema(
    shows.filter(s => s.status !== 'previews' && s.status !== 'upcoming').map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      startDate: show.openingDate,
      endDate: show.closingDate,
      status: show.status,
      category: 'off-broadway',
    })),
    'Off-Broadway Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  // Only show currently open/previews OB shows (no historical inventory yet)
  const activeShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  const serializedShows = activeShows.map(serializeShow);

  // Count reviews across active OB shows only
  const totalReviews = activeShows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  // Starting Soon — upcoming OB shows (not yet in previews), soonest first.
  // Mirrors the Broadway homepage shelf (src/app/page.tsx). Computed here rather
  // than in the client so it stays out of the search/filter inventory, which is
  // active shows only. Excludes opera to match the project-wide convention that
  // opera is kept out of the homepage/OB shelves (see isHomepageNotable in
  // lib/homepage-notability.ts) — the Broadway shelf is opera-free for the same
  // reason (opera lives in its own category). Dates are normalized to the date
  // portion and parsed at local noon so the badge/subtitle never read "Invalid
  // Date"; anything unparseable is dropped (fail closed) rather than shown.
  const startMs = (s: typeof shows[number]): number => {
    const raw = (s.previewsStartDate || s.openingDate)?.slice(0, 10);
    const t = raw ? new Date(`${raw}T12:00:00`).getTime() : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  const shortDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startingSoonShows = shows
    .filter(s => s.status === 'upcoming' && s.type !== 'opera' && Number.isFinite(startMs(s)))
    .sort((a, b) => startMs(a) - startMs(b))
    .map(s => {
      const startDate = s.previewsStartDate || s.openingDate;
      return { ...serializeShow(s), subtitle: `Starts ${shortDate(startDate)}`, subtitleColor: 'text-gray-400' };
    });

  // Recently Opened · Awaiting Reviews — open OB shows that opened within the
  // recency window but don't yet have enough reviews to display a score. These
  // are the shows that otherwise vanish: dropped from "Upcoming" when they open,
  // hidden from the scored list by the review gate. Newest first. Uses the same
  // canonical predicate as the `recently-opened-off-broadway` browse page.
  const openMs = (s: typeof shows[number]): number => {
    const raw = s.openingDate?.slice(0, 10);
    const t = raw ? new Date(`${raw}T12:00:00`).getTime() : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const justOpenedShows = shows
    .filter(s => isRecentlyOpenedAwaitingReviews(s))
    .sort((a, b) => openMs(b) - openMs(a))
    .map(s => ({ ...serializeShow(s), subtitle: `Opened ${shortDate(s.openingDate)}`, subtitleColor: 'text-emerald-400' }));

  // Top Recent Shows shelf — computed here (not in the client) so the LCP poster
  // lands in the static HTML. The client renders `skipAboveFold` to avoid a
  // duplicate. Mirrors the client's topRecentShows predicate exactly (#317).
  const obHasEnoughReviews = (s: OffBroadwayShow) => hasEnoughReviews(
    s.criticScore?.reviewCount ?? 0,
    'off-broadway',
    (s.criticScore?.tier1Count ?? 0) + (s.criticScore?.tier2Count ?? 0),
  );
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const topRecentShows = serializedShows
    .filter(s => {
      if (!s.criticScore?.score || !obHasEnoughReviews(s)) return false;
      if (s.status === 'previews' || s.status === 'upcoming') return false;
      return new Date(s.openingDate) >= twelveMonthsAgo;
    })
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));

  const preloadPosterUrls = topRecentShows
    .slice(0, 4)
    .map(s => {
      const img = s.images?.poster || s.images?.thumbnail || s.images?.hero;
      return img ? getOptimizedImageUrl(img, 'card') : null;
    })
    .filter((u): u is string => !!u);

  // Client only renders the Top Recent shelf when there are >3 shows; match that
  // so the above-fold layout is identical whether server- or client-rendered.
  const showServerShelf = topRecentShows.length > 3;

  return (
    <>
      {showServerShelf && preloadPosterUrls.map((url, i) => (
        <link key={`preload-${i}`} rel="preload" as="image" href={url} fetchPriority={i === 0 ? 'high' : undefined} />
      ))}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      {/* Server-rendered hero + Gold List CTA + Top Recent Shows shelf — LCP image
          appears in the initial HTML. The client below renders skipAboveFold. */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-5 sm:pt-12">
        <div className="mb-4 sm:mb-8">
          <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
            Off-Broadway<span className="text-gradient">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl">
            Every show. Every review. One score.
          </p>
          <p className="text-gray-500 text-sm sm:text-base mt-1">
            {activeShows.length} shows. {totalReviews.toLocaleString()} critic reviews. And counting.
          </p>
        </div>
        <GoldListCTA listType="critical-gold-off-broadway" />
        {showServerShelf && (
          <FeaturedRowServer shows={topRecentShows} title="Top Recent Shows" />
        )}
      </div>

      <Suspense>
        <OffBroadwayPageClient
          shows={serializedShows}
          archiveHash={archiveHash}
          startingSoonShows={startingSoonShows}
          justOpenedShows={justOpenedShows}
          totalShows={activeShows.length}
          totalReviews={totalReviews}
          marketOpenCounts={{
            broadway: getMarketStats().nyc.openShows,
            // The "Broadway+" pill links to / which mixes in open curated OB
            // picks — count must match what that page actually shows
            broadwayPlus:
              getMarketStats().nyc.openShows +
              getNotableOffBroadwayShows().filter(s => s.status === 'open').length,
            offBroadway: getMarketStats().offBroadway?.openShows ?? 0,
          }}
          awardWinnerSets={getAwardWinnerSets()}
          skipAboveFold
        />
      </Suspense>
    </>
  );
}
