import { Metadata } from 'next';
import { versionedImagePath } from '@/lib/versioned-image-path';
import { getAllTheaters } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL, SITE_OG_IMAGE } from '@/lib/seo';
import { getTheaterAvgScore } from '@/lib/theater-avg-score';
import TheaterIndexClient from './TheaterIndexClient';


/** Local theater image path (Wikimedia hotlinking deprecated April 2026) */
function getTheaterImageUrl(slug: string): string {
  return versionedImagePath(`/images/theaters/${slug}.jpg`);
}

export const metadata: Metadata = {
  title: 'Broadway Theaters - All NYC Theater Venues',
  description: 'Browse all Broadway theaters in New York City. See what shows are currently playing at each venue with CriticScore ratings and reviews.',
  alternates: {
    canonical: `${BASE_URL}/theater`,
  },
  openGraph: {
    images: [SITE_OG_IMAGE],
    title: 'Broadway Theaters',
    description: 'Browse all Broadway theaters and see what shows are currently playing.',
    url: `${BASE_URL}/theater`,
  },
};

export default function TheatersIndexPage() {
  const theaters = getAllTheaters();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Theaters', url: `${BASE_URL}/theater` },
  ]);

  // Strip heavy show data — only pass what the client needs
  const theaterSummaries = theaters.map(t => {
    const { avgScore } = getTheaterAvgScore(t.allShows);

    return {
      name: t.name,
      slug: t.slug,
      address: t.address,
      showCount: t.showCount,
      capacity: t.capacity ?? null,
      currentShowTitle: t.currentShow?.title,
      currentShowStatus: t.currentShow?.status as 'open' | 'previews' | 'upcoming' | undefined,
      avgScore,
      imageUrl: getTheaterImageUrl(t.slug),
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema).replace(/</g, '\\u003c') }}
      />
      <TheaterIndexClient theaters={theaterSummaries} />
    </>
  );
}
