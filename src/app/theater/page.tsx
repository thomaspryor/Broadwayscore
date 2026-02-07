import { Metadata } from 'next';
import { getAllTheaters } from '@/lib/data-core';
import { generateBreadcrumbSchema } from '@/lib/seo';
import TheaterIndexClient from './TheaterIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Theaters - All NYC Theater Venues',
  description: 'Browse all Broadway theaters in New York City. See what shows are currently playing at each venue with critic scores and reviews.',
  alternates: {
    canonical: `${BASE_URL}/theater`,
  },
  openGraph: {
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
  const theaterSummaries = theaters.map(t => ({
    name: t.name,
    slug: t.slug,
    address: t.address,
    showCount: t.showCount,
    currentShowTitle: t.currentShow?.title,
    currentShowSlug: t.currentShow?.slug,
    currentShowScore: t.currentShow?.criticScore?.score ?? null,
  }));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <TheaterIndexClient theaters={theaterSummaries} />
    </>
  );
}
