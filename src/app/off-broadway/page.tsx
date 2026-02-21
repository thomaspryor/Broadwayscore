import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getOffBroadwayShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';
import BrowseListClient from '@/components/BrowseListClient';
import type { BrowseShow } from '@/components/BrowseListClient';
import { featureFlags } from '@/config/feature-flags';

export const metadata: Metadata = {
  title: 'Off-Broadway Scorecard - NYC Off-Broadway Show Ratings & Reviews',
  description: 'Critic scores for Off-Broadway shows in New York City, aggregated from The New York Times, Vulture, Variety, Time Out, and more.',
  alternates: {
    canonical: `${BASE_URL}/off-broadway`,
  },
  openGraph: {
    title: 'Off-Broadway Scorecard - NYC Show Ratings',
    description: 'Aggregated critic scores for Off-Broadway shows from The New York Times, Vulture, Variety, and more.',
    url: `${BASE_URL}/off-broadway`,
    type: 'article',
  },
};

export default function OffBroadwayPage() {
  if (!featureFlags.offBroadway) {
    notFound();
  }

  const shows = getOffBroadwayShows();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-Broadway', url: `${BASE_URL}/off-broadway` },
  ]);

  const itemListSchema = generateItemListSchema(
    shows.map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      startDate: show.openingDate,
      endDate: show.closingDate,
      status: show.status,
      category: 'off-broadway',
    })),
    'Off-Broadway Shows'
  );

  const schemas = [breadcrumbSchema, itemListSchema];

  // Compute display flags
  const isMixedType = new Set(shows.map(s => s.type)).size > 1;
  const statuses = new Set(shows.map(s => s.status === 'open' || s.status === 'previews' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;

  // Serialize shows for client component
  const serializedShows: BrowseShow[] = shows.map(show => {
    const buzz = getAudienceBuzz(show.id);
    return {
      id: show.id,
      slug: show.slug,
      title: show.title,
      venue: show.venue,
      openingDate: show.openingDate,
      closingDate: show.closingDate ?? undefined,
      status: show.status,
      type: show.type,
      isRevival: show.isRevival ?? undefined,
      images: show.images,
      criticScore: show.criticScore
        ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount }
        : undefined,
      audienceCombinedScore: buzz?.combinedScore ?? null,
      audienceGrade: buzz ? getAudienceGrade(buzz.combinedScore) : null,
      category: 'off-broadway',
    };
  });

  const scoredCount = serializedShows.filter(s => s.criticScore?.score && (s.criticScore?.reviewCount ?? 0) >= 3).length;

  // Compute data freshness from latest review publish date
  const latestReviewDate = shows.reduce((latest, s) => {
    for (const r of s.criticScore?.reviews || []) {
      if (r.publishDate && r.publishDate > latest) return r.publishDate;
    }
    return latest;
  }, '');
  const dataFreshness = latestReviewDate
    ? new Date(latestReviewDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: 'Off-Broadway' },
        ]} />

        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">Off-Broadway Scorecard</h1>
          <p className="text-gray-300 leading-relaxed">
            Critic scores for Off-Broadway shows in NYC, aggregated from The New York Times, Vulture, Variety, Time Out, and more.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            {shows.length} shows ({scoredCount} scored) | Last updated: {dataFreshness}
          </p>
        </div>

        {/* Interactive Show List */}
        <BrowseListClient
          shows={serializedShows}
          showRanks={true}
          isMixedType={isMixedType}
          isMixedStatus={isMixedStatus}
          defaultSort="score"
          hasPerformanceData={false}
          availableSorts={['score', 'alpha', 'newest']}
          showTypeFilter={isMixedType}
          showScoreToggle={true}
        />

        {/* Methodology Link */}
        <div className="mt-8 text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
