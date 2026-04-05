import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getWestEndShows } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import WestEndPageClient from '@/components/WestEndPageClient';
import type { WestEndShow } from '@/components/WestEndPageClient';
import { featureFlags } from '@/config/feature-flags';

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
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    images: [`${BASE_URL}/og/home.png`],
  },
};

function serializeShow(show: ReturnType<typeof getWestEndShows>[number]): WestEndShow {
  return serializeShowForClient(show, {
    isOffWestEnd: show.category === 'off-west-end',
    category: (show.category as string) || 'west-end',
  });
}

export default function WestEndPage() {
  if (!featureFlags.westEnd) {
    notFound();
  }

  // getWestEndShows() already returns both WE + OWE shows
  const shows = getWestEndShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
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
      category: show.category || 'west-end',
    })),
    'West End Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  // Scored shows + upcoming/previews (upcoming shelf needs unscored shows)
  const scoredShows = shows.filter(s => s.criticScore && s.criticScore.reviewCount >= 1);
  const allRelevantShows = shows.filter(s =>
    (s.criticScore && s.criticScore.reviewCount >= 1) ||
    s.status === 'upcoming' || s.status === 'previews'
  );
  const serializedShows = allRelevantShows.map(serializeShow);

  // Count reviews across all scored shows (WE + OWE)
  const totalReviews = scoredShows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <Suspense>
        <WestEndPageClient
          shows={serializedShows}
          totalShows={scoredShows.length}
          totalReviews={totalReviews}
          scoredShows={scoredShows.length}
        />
      </Suspense>
    </>
  );
}
