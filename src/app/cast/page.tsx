import type { Metadata } from 'next';
import { getAllActorProfiles } from '@/lib/data-actors';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import { CAST_DEFAULT_MIN_SCORED, getCastIndexProfiles, splitCastIndex } from '@/lib/cast-index';
import CreativeIndexClient from '@/components/creative/CreativeIndexClient';

export const metadata: Metadata = {
  title: 'Broadway Cast Members',
  description: 'Browse Broadway actors and actresses ranked by number of shows and average critic score. Explore every performer\'s Broadway career.',
  alternates: { canonical: `${BASE_URL}/cast` },
  openGraph: {
    title: 'Broadway Cast Members',
    description: 'Browse Broadway actors and actresses ranked by number of shows and average critic score. Explore every performer\'s Broadway career.',
    url: `${BASE_URL}/cast`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: { card: 'summary' },
};

export default function CastIndexPage() {
  const profiles = getAllActorProfiles();
  const totalShows = new Set(profiles.flatMap(p => p.shows.map(s => s.slug))).size;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Cast', url: `${BASE_URL}/cast` },
  ]);

  const itemListSchema = generateItemListSchema(
    profiles.slice(0, 50).map(p => ({
      name: p.name,
      url: `${BASE_URL}/cast/${p.slug}`,
    })),
    'Broadway Cast Members',
    'Person'
  );

  const { main: summaries, rest } = splitCastIndex(getCastIndexProfiles());

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />
      <CreativeIndexClient
        profiles={summaries}
        extraProfilesUrl="/cast-index.json"
        totalProfiles={summaries.length + rest.length}
        categoryLabel="Cast Members"
        routePath="cast"
        totalShows={totalShows}
        showObcFilter
        defaultMinShows={CAST_DEFAULT_MIN_SCORED}
        defaultSort="avg"
        subtitle="Covers productions from 1970 to present. Critic scores available from 2005."
      />
    </div>
  );
}
