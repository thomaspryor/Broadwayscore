import { Metadata } from 'next';
import { getAllLondonTheaters, getAllWestEndComplexes } from '@/lib/data-core';
import { generateBreadcrumbSchema } from '@/lib/seo';
import LondonTheaterIndexClient from './LondonTheaterIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: { absolute: 'West End Theatres — All London Venues' },
  description:
    'Browse every West End and Off-West End theatre in London. See what shows are currently playing at each venue with CriticScore ratings and reviews.',
  alternates: {
    canonical: `${BASE_URL}/west-end/theater`,
  },
  openGraph: {
    title: 'West End Theatres',
    description:
      'Browse every West End and Off-West End theatre in London and see what shows are currently playing.',
    url: `${BASE_URL}/west-end/theater`,
    siteName: 'West End Scorecard',
  },
};

export default function LondonTheaterIndexPage() {
  const theaters = getAllLondonTheaters();
  const complexes = getAllWestEndComplexes();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'Theatres', url: `${BASE_URL}/west-end/theater` },
  ]);

  // Complexes replace their sub-venues (and their own same-slug entry) in the
  // index so a user sees one row per recognizable place — "National Theatre",
  // not "National Theatre" AND "Olivier Theatre" separately.
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
      <LondonTheaterIndexClient theaters={theaterSummaries} />
    </>
  );
}
