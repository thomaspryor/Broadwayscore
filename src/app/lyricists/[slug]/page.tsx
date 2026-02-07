import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCreativeBySlug, getCreativeSlugs, getCreativeProfiles, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { generateBreadcrumbSchema, generateCreativePersonSchema, generateCreativeFAQSchema, BASE_URL } from '@/lib/seo';
import CreativeDetailClient from '@/components/creative/CreativeDetailClient';

const CAT = 'lyricist' as const;
const config = CREATIVE_CATEGORY_CONFIG[CAT];

export function generateStaticParams() {
  return getCreativeSlugs(CAT).map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const profile = getCreativeBySlug(CAT, params.slug);
  if (!profile) return {};

  const title = `${profile.name} — Broadway ${config.label} | Broadway Scorecard`;
  const description = `${profile.name} has ${config.verbPast} ${profile.showCount} Broadway show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? ` with an avg critic score of ${profile.avgScore}` : ''}. See all shows.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/${config.routePath}/${profile.slug}` },
    openGraph: {
      title: `${profile.name} — Broadway ${config.label}`,
      description,
      url: `${BASE_URL}/${config.routePath}/${profile.slug}`,
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary' },
  };
}

export default function LyricistDetailPage({ params }: { params: { slug: string } }) {
  const profile = getCreativeBySlug(CAT, params.slug);
  if (!profile) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: config.labelPlural, url: `${BASE_URL}/${config.routePath}` },
    { name: profile.name, url: `${BASE_URL}/${config.routePath}/${profile.slug}` },
  ]);

  const personSchema = generateCreativePersonSchema(profile, config.routePath, config.label);
  const faqSchema = generateCreativeFAQSchema(profile, config.label, config.verbPast);

  const profiles = getCreativeProfiles(CAT);
  const rank = profiles.findIndex(p => p.slug === profile.slug) + 1;

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, personSchema, faqSchema]) }}
      />
      <CreativeDetailClient
        profile={profile}
        categoryLabel={config.label}
        categoryLabelPlural={config.labelPlural}
        routePath={config.routePath}
        rank={rank}
      />
    </div>
  );
}
