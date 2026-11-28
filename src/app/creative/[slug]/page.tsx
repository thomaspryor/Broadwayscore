import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getUnifiedCreativeProfile, getUnifiedCreativeSlugs, getAllUnifiedCreativeProfiles, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { getPersonTonyStatsByName, getShowTonyMapByName } from '@/lib/data-tony-noms';
import { generateBreadcrumbSchema, generateUnifiedCreativePersonSchema, generateUnifiedCreativeFAQSchema, BASE_URL } from '@/lib/seo';
import { isThinCreative } from '@/lib/creative-indexability';
import UnifiedCreativeDetailClient from '@/components/creative/UnifiedCreativeDetailClient';

export const revalidate = 86400;

export function generateStaticParams() {
  return []; // On-demand via ISR — saves ~2,200 pages of build time
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const profile = getUnifiedCreativeProfile(params.slug);
  if (!profile) return {};

  const categoryLabels = profile.categories.map(c => CREATIVE_CATEGORY_CONFIG[c].label);
  const rolesText = categoryLabels.join(', ');
  const title = `${profile.name}: Broadway ${rolesText}`;
  const description = `${profile.name} is a Broadway ${rolesText.toLowerCase()} with ${profile.showCount} show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? ` and an avg critic score of ${profile.avgScore}` : ''}. See all shows and roles.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/creative/${profile.slug}` },
    // One show, no score, no Tony record: soft-404 shape (BRO-5399)
    ...(isThinCreative(profile) ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/creative/${profile.slug}`,
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary' },
  };
}

export default async function UnifiedCreativeDetailPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
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
        tonyStats={getPersonTonyStatsByName(profile.name)}
        tonyByShow={getShowTonyMapByName(profile.name)}
      />
    </div>
  );
}
