import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import WestEndPageClient from '@/components/WestEndPageClient';
import type { WestEndShow } from '@/components/WestEndPageClient';
import { featureFlags } from '@/config/feature-flags';

export const metadata: Metadata = {
  title: 'West End Scorecard - London Theatre Ratings & Reviews',
  description: 'CriticScore ratings for London West End shows. See which musicals and plays are getting the best reviews from UK theatre critics.',
  alternates: {
    canonical: `${BASE_URL}/west-end`,
  },
  openGraph: {
    title: 'West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    url: `${BASE_URL}/west-end`,
    type: 'article',
  },
};

function serializeShow(show: ReturnType<typeof getWestEndShows>[number]): WestEndShow {
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

export default function WestEndPage() {
  if (!featureFlags.westEnd) {
    notFound();
  }

  const shows = getWestEndShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
  ]);

  const itemListSchema = generateItemListSchema(
    shows.map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      startDate: show.openingDate,
      endDate: show.closingDate,
      status: show.status,
      category: 'west-end',
    })),
    'West End Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  const serializedShows = shows.map(serializeShow);

  // Count reviews across all WE shows
  const totalReviews = shows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <WestEndPageClient
        shows={serializedShows}
        totalShows={shows.length}
        totalReviews={totalReviews}
      />
    </>
  );
}
