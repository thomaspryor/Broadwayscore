import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getUnifiedCreativeProfile, getUnifiedCreativeSlugs, getAllUnifiedCreativeProfiles, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { generateBreadcrumbSchema, generateUnifiedCreativePersonSchema, generateUnifiedCreativeFAQSchema, BASE_URL } from '@/lib/seo';
import UnifiedCreativeDetailClient from '@/components/creative/UnifiedCreativeDetailClient';

export function generateStaticParams() {
  return getUnifiedCreativeSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const profile = getUnifiedCreativeProfile(params.slug);
  if (!profile) return {};

  const categoryLabels = profile.categories.map(c => CREATIVE_CATEGORY_CONFIG[c].label);
  const rolesText = categoryLabels.join(', ');
  const title = `${profile.name} — Broadway ${rolesText}`;
  const description = `${profile.name} is a Broadway ${rolesText.toLowerCase()} with ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? ` and an avg critic score of ${profile.avgScore}` : ''}. See all shows and roles.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/creative/${profile.slug}` },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/creative/${profile.slug}`,
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary' },
  };
}

export default function UnifiedCreativeDetailPage({ params }: { params: { slug: string } }) {
  const profile = getUnifiedCreativeProfile(params.slug);
  if (!profile) notFound();

  const categoryLabels = profile.categories.map(c => CREATIVE_CATEGORY_CONFIG[c].label);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Creative Team', url: `${BASE_URL}/directors` },
    { name: profile.name, url: `${BASE_URL}/creative/${profile.slug}` },
  ]);

  const personSchema = generateUnifiedCreativePersonSchema(profile, categoryLabels);
  const faqSchema = generateUnifiedCreativeFAQSchema(profile, categoryLabels);

  const allProfiles = getAllUnifiedCreativeProfiles();
  const rank = allProfiles.findIndex(p => p.slug === profile.slug) + 1;

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, personSchema, faqSchema]) }}
      />
      <UnifiedCreativeDetailClient
        profile={profile}
        categoryLabels={categoryLabels}
        rank={rank}
      />
    </div>
  );
}
