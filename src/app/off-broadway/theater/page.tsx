import { Metadata } from 'next';
import { getAllOffBroadwayTheaters } from '@/lib/data-core';
import { generateBreadcrumbSchema } from '@/lib/seo';
import OffBroadwayTheaterIndexClient from './OffBroadwayTheaterIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: { absolute: 'Off-Broadway Theaters — All NYC Venues' },
  description:
    'Browse every Off-Broadway theater in New York City. See what shows are currently playing at each venue with CriticScore ratings and reviews.',
  alternates: {
    canonical: `${BASE_URL}/off-broadway/theater`,
  },
  openGraph: {
    title: 'Off-Broadway Theaters',
    description:
      'Browse every Off-Broadway theater in New York City and see what shows are currently playing.',
    url: `${BASE_URL}/off-broadway/theater`,
    siteName: 'Broadway Scorecard',
  },
};

export default function OffBroadwayTheaterIndexPage() {
  const theaters = getAllOffBroadwayTheaters();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-Broadway', url: `${BASE_URL}/off-broadway` },
    { name: 'Theaters', url: `${BASE_URL}/off-broadway/theater` },
  ]);

  // Strip heavy show data — only pass what the client needs
  const theaterSummaries = theaters.map(t => {
    const scoredShows = t.allShows.filter(s => s.criticScore?.score != null);
    const avgScore = scoredShows.length > 0
      ? Math.round(scoredShows.reduce((sum, s) => sum + (s.criticScore?.score ?? 0), 0) / scoredShows.length)
      : null;

    return {
      name: t.name,
      slug: t.slug,
      address: t.address,
      showCount: t.showCount,
      currentShowTitle: t.currentShow?.title,
      currentShowStatus: t.currentShow?.status as 'open' | 'previews' | 'upcoming' | undefined,
      avgScore,
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema).replace(/</g, '\\u003c') }}
      />
      <OffBroadwayTheaterIndexClient theaters={theaterSummaries} />
    </>
  );
}
