import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOffWestEndShows } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import OffWestEndPageClient from '@/components/OffWestEndPageClient';
import type { OffWestEndShow } from '@/components/OffWestEndPageClient';
import { featureFlags } from '@/config/feature-flags';

const currentYear = new Date().getFullYear();

export const metadata: Metadata = {
  title: {
    absolute: `Best Off-West End Shows (${currentYear}) — London Theatre Reviews & Ratings`,
  },
  description: 'CriticScore ratings for Off-West End shows in London, aggregated from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
  alternates: {
    canonical: `${BASE_URL}/off-west-end`,
  },
  openGraph: {
    title: 'Off-West End Scorecard - London Theatre Ratings',
    description: 'Aggregated CriticScore ratings for Off-West End shows from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    url: `${BASE_URL}/off-west-end`,
    type: 'article',
  },
};

function serializeShow(show: ReturnType<typeof getOffWestEndShows>[number]): OffWestEndShow {
  return serializeShowForClient(show, { category: 'off-west-end' });
}

export default function OffWestEndPage() {
  if (!featureFlags.westEnd) {
    notFound();
  }

  const shows = getOffWestEndShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-West End', url: `${BASE_URL}/off-west-end` },
  ]);

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
      category: 'off-west-end',
    })),
    'Off-West End Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  const activeShows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  const serializedShows = activeShows.map(serializeShow);
  const totalReviews = activeShows.reduce((sum, s) => sum + (s.criticScore?.reviewCount ?? 0), 0);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <Suspense>
        <OffWestEndPageClient
          shows={serializedShows}
          totalShows={activeShows.length}
          totalReviews={totalReviews}
        />
      </Suspense>
    </>
  );
}
