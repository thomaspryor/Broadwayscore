import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOffBroadwayShows, getMarketStats } from '@/lib/data-core';
import { getAwardWinnerSets } from '@/lib/data-awards';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import { isRecentlyOpenedAwaitingReviews } from '@/lib/recently-opened';
import OffBroadwayPageClient from '@/components/OffBroadwayPageClient';
import type { OffBroadwayShow } from '@/components/OffBroadwayPageClient';
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

function serializeShow(show: ReturnType<typeof getOffBroadwayShows>[number]): OffBroadwayShow {
  return serializeShowForClient(show, { category: 'off-broadway' });
}

export default function OffBroadwayPage() {
  if (!featureFlags.offBroadway) {
    notFound();
  }

  const shows = getOffBroadwayShows();

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

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <Suspense>
        <OffBroadwayPageClient
          shows={serializedShows}
          startingSoonShows={startingSoonShows}
          justOpenedShows={justOpenedShows}
          totalShows={activeShows.length}
          totalReviews={totalReviews}
          marketOpenCounts={{
            broadway: getMarketStats().nyc.openShows,
            offBroadway: getMarketStats().offBroadway?.openShows ?? 0,
          }}
          awardWinnerSets={getAwardWinnerSets()}
        />
      </Suspense>
    </>
  );
}
