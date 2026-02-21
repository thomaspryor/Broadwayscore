import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getActorBySlug, getAllActorSlugs, getAllActorProfiles } from '@/lib/data-actors';
import { getPersonTonyStats, getShowTonyMap } from '@/lib/data-tony-noms';
import { generateBreadcrumbSchema, generateActorPersonSchema, generateActorFAQSchema, BASE_URL } from '@/lib/seo';
import ActorDetailClient from './ActorDetailClient';

export function generateStaticParams() {
  return getAllActorSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const profile = getActorBySlug(params.slug);
  if (!profile) return {};

  const title = `${profile.name} — Broadway Actor`;
  const description = `${profile.name} has appeared in ${profile.showCount} Broadway show${profile.showCount !== 1 ? 's' : ''}${profile.avgScore !== null ? ` with an avg critic score of ${profile.avgScore}` : ''}. See all Broadway credits and scores.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/cast/${profile.slug}` },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/cast/${profile.slug}`,
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary' },
  };
}

export default function ActorDetailPage({ params }: { params: { slug: string } }) {
  const profile = getActorBySlug(params.slug);
  if (!profile) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Cast', url: `${BASE_URL}/cast` },
    { name: profile.name, url: `${BASE_URL}/cast/${profile.slug}` },
  ]);

  const personSchema = generateActorPersonSchema(profile);
  const faqSchema = generateActorFAQSchema(profile);

  const allProfiles = getAllActorProfiles();
  const rank = allProfiles.findIndex(p => p.slug === profile.slug) + 1;

  // Highest-rated rank: position among actors with avgScore and 3+ credits, sorted desc
  // Filtering to 3+ credits prevents single-show actors from skewing the ranking
  const scoredProfiles = allProfiles.filter(p => p.avgScore !== null && p.scoredShowCount >= 3);
  scoredProfiles.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
  const highestRatedRank = (profile.avgScore !== null && profile.scoredShowCount >= 3)
    ? scoredProfiles.findIndex(p => p.slug === profile.slug) + 1
    : 0;

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, personSchema, faqSchema]) }}
      />
      <ActorDetailClient
        profile={profile}
        rank={rank}
        highestRatedRank={highestRatedRank}
        tonyStats={getPersonTonyStats(profile.ibdbPersonId)}
        tonyByShow={getShowTonyMap(profile.ibdbPersonId)}
      />
    </div>
  );
}
