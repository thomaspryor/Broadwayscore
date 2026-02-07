import { Metadata } from 'next';
import { getAllDirectors } from '@/lib/data-core';
import { generateBreadcrumbSchema } from '@/lib/seo';
import DirectorIndexClient from './DirectorIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Directors - All Directors & Their Shows',
  description: 'Browse all Broadway directors and see their shows with critic scores. Find productions by your favorite theater directors.',
  alternates: {
    canonical: `${BASE_URL}/director`,
  },
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: 'Broadway Directors',
    description: 'Browse all Broadway directors and their productions with critic scores.',
    url: `${BASE_URL}/director`,
  },
};

export default function DirectorsIndexPage() {
  const directors = getAllDirectors();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Directors', url: `${BASE_URL}/director` },
  ]);

  // Strip heavy show data — only pass what the client needs
  const directorSummaries = directors.map(d => ({
    name: d.name,
    slug: d.slug,
    showCount: d.showCount,
    avgScore: d.avgScore,
  }));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <DirectorIndexClient directors={directorSummaries} />
    </>
  );
}
