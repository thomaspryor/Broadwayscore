import type { Metadata } from 'next';
import { getCreativeProfiles, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import CreativeIndexClient from '@/components/creative/CreativeIndexClient';

const CAT = 'director' as const;
const config = CREATIVE_CATEGORY_CONFIG[CAT];

export const metadata: Metadata = {
  title: `Broadway ${config.labelPlural} | Broadway Scorecard`,
  description: `Browse all Broadway ${config.labelPlural.toLowerCase()} ranked by number of shows and average critic score. Find every ${config.label.toLowerCase()}'s Broadway career.`,
  alternates: { canonical: `${BASE_URL}/${config.routePath}` },
  openGraph: {
    title: `Broadway ${config.labelPlural}`,
    description: `Browse all Broadway ${config.labelPlural.toLowerCase()} ranked by number of shows and average critic score.`,
    url: `${BASE_URL}/${config.routePath}`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: { card: 'summary' },
};

export default function DirectorsIndexPage() {
  const profiles = getCreativeProfiles(CAT);
  const totalShows = new Set(profiles.flatMap(p => p.shows.map(s => s.slug))).size;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: config.labelPlural, url: `${BASE_URL}/${config.routePath}` },
  ]);

  const itemListSchema = generateItemListSchema(
    profiles.slice(0, 50).map(p => ({
      name: p.name,
      url: `${BASE_URL}/${config.routePath}/${p.slug}`,
    })),
    `Broadway ${config.labelPlural}`
  );

  const summaries = profiles.map(({ shows, ...rest }) => rest);

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />
      <CreativeIndexClient
        profiles={summaries}
        categoryLabel={config.labelPlural}
        routePath={config.routePath}
        totalShows={totalShows}
      />
    </div>
  );
}
