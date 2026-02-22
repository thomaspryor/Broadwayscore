import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOffBroadwayShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import OffBroadwayPageClient from '@/components/OffBroadwayPageClient';
import type { OffBroadwayShow } from '@/components/OffBroadwayPageClient';
import { featureFlags } from '@/config/feature-flags';

export const metadata: Metadata = {
  title: 'Off-Broadway Scorecard - NYC Off-Broadway Show Ratings & Reviews',
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
  const buzz = getAudienceBuzz(show.id);
  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    venue: show.venue,
    openingDate: show.openingDate,
    closingDate: show.closingDate ?? undefined,
    status: show.status,
    type: show.type,
    isRevival: show.isRevival ?? undefined,
    reviewYearNote: show.reviewYearNote ?? undefined,
    images: show.images,
    criticScore: show.criticScore
      ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount }
      : undefined,
    audienceCombinedScore: buzz?.combinedScore ?? null,
    audienceGrade: buzz ? getAudienceGrade(buzz.combinedScore) : null,
    creativeTeam: show.creativeTeam,
  };
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

  // Pass ALL shows to client — it handles filtering via status toggles
  const serializedShows = shows.map(serializeShow);

  // Count reviews across all OB shows
  const totalReviews = shows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <OffBroadwayPageClient
        shows={serializedShows}
        totalShows={shows.length}
        totalReviews={totalReviews}
      />
    </>
  );
}
