import { Metadata } from 'next';
import { getAllOffBroadwayTheaters, getAllOffBroadwayComplexes } from '@/lib/data-core';
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
  const complexes = getAllOffBroadwayComplexes();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-Broadway', url: `${BASE_URL}/off-broadway` },
    { name: 'Theaters', url: `${BASE_URL}/off-broadway/theater` },
  ]);

  // Complexes replace their sub-venues (and their own same-slug entry) in the
  // index so a user sees one row per recognizable place — "Atlantic Theater
  // Company", not "Atlantic Theater Company" AND "Atlantic Stage 2" separately.
  const rolledUpSlugs = new Set(complexes.flatMap(c => [c.slug, ...c.subVenues.map(sv => sv.slug)]));
  const standaloneTheaters = theaters.filter(t => !rolledUpSlugs.has(t.slug));
  const rows = [...standaloneTheaters, ...complexes];

  // Strip heavy show data — only pass what the client needs
  const theaterSummaries = rows.map(t => {
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
