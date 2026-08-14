import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getOffBroadwayTheaterBySlug, getAllOffBroadwayTheaterSlugs } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { ScoreBadge, FormatPill, ProductionPill, StatusBadge, getScoreTier } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { getBroadwayDuration } from '@/lib/date-utils';
import TheaterDetailClient from '../../../theater/[slug]/TheaterDetailClient';
import Breadcrumb from '@/components/Breadcrumb';

export function generateStaticParams() {
  return getAllOffBroadwayTheaterSlugs().map((slug) => ({ slug }));
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const theater = getOffBroadwayTheaterBySlug(params.slug);
  if (!theater) return { title: 'Theater Not Found' };

  const canonicalUrl = `${BASE_URL}/off-broadway/theater/${params.slug}`;
  const currentShowText = theater.currentShow
    ? `Currently showing: ${theater.currentShow.title}.`
    : 'View show history and information.';
  const description = `${theater.name} in New York City. ${currentShowText} See all ${theater.showCount} shows, scores, and theater details.`;

  return {
    title: { absolute: `${theater.name} — Off-Broadway Theater` },
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${theater.name} — Off-Broadway Theater`,
      description,
      url: canonicalUrl,
      type: 'website',
      siteName: 'Broadway Scorecard',
    },
    twitter: {
      card: 'summary',
      title: `${theater.name} — Off-Broadway Theater`,
      description,
    },
  };
}

export default function OffBroadwayTheaterPage({ params }: { params: { slug: string } }) {
  const theater = getOffBroadwayTheaterBySlug(params.slug);
  if (!theater) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Off-Broadway', url: `${BASE_URL}/off-broadway` },
    { name: 'Theaters', url: `${BASE_URL}/off-broadway/theater` },
    { name: theater.name, url: `${BASE_URL}/off-broadway/theater/${params.slug}` },
  ]);

  // Compute stats
  const scoredShows = theater.allShows.filter(s => s.criticScore?.score != null);
  const avgScore = scoredShows.length > 0
    ? Math.round(scoredShows.reduce((sum, s) => sum + (s.criticScore?.score ?? 0), 0) / scoredShows.length)
    : null;

  // Serialize shows for client component (identical shape to Broadway detail page)
  const theaterShows = theater.allShows.map(show => {
    const buzz = getAudienceBuzz(show.id);
    return {
      id: show.id,
      slug: show.slug,
      title: show.title,
      openingDate: show.openingDate || show.previewsStartDate || '',
      closingDate: show.closingDate ?? undefined,
      status: show.status,
      type: show.type,
      isRevival: show.isRevival ?? undefined,
      images: show.images,
      criticScore: show.criticScore
        ? {
            score: show.criticScore.score,
            reviewCount: show.criticScore.reviewCount,
            tier1Count: show.criticScore.tier1Count,
            tier2Count: show.criticScore.tier2Count,
          }
        : undefined,
      audienceCombinedScore: buzz && hasEnoughAudienceReviews(buzz) ? buzz.combinedScore : null,
      audienceGrade: buzz && hasEnoughAudienceReviews(buzz) ? getAudienceGrade(buzz.combinedScore) : null,
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([breadcrumbSchema]).replace(/</g, '\\u003c'),
        }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Off-Broadway', href: '/off-broadway' },
            { label: 'Theaters', href: '/off-broadway/theater' },
            { label: theater.name },
          ]}
        />

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{theater.name}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                {theater.address && (
                  <a
                    href={getGoogleMapsUrl(theater.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-400 text-sm hover:text-brand transition-colors inline-flex items-center gap-1"
                  >
                    {theater.address}
                    <svg className="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
                <span className="text-gray-500 text-xs">New York City</span>
              </div>
            </div>
          </div>

          {/* Stats row (no capacity — not available for off-Broadway venues yet) */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="card p-3 sm:p-4 text-center">
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Past Shows</p>
              <p className="text-xl sm:text-2xl font-bold text-white">{theater.allShows.length}</p>
            </div>
            <div className="card p-3 sm:p-4 text-center">
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Avg Score</p>
              <div className="flex justify-center">
                <ScoreBadge score={avgScore ?? undefined} size="sm" />
              </div>
            </div>
          </div>

          {/* Now Playing */}
          {theater.currentShow && (
            <Link
              href={`/show/${theater.currentShow.slug}`}
              className="card p-4 sm:p-5 mb-4 border border-status-open/30 hover:border-status-open/50 transition-colors group block"
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-status-open mb-2">Now Playing</p>
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                  {theater.currentShow.images?.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={getOptimizedImageUrl(theater.currentShow.images.thumbnail, 'thumbnail')}
                      alt={theater.currentShow.title}
                      className="w-full h-full object-cover"
                      loading="eager"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><span className="text-xl">🎭</span></div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-white group-hover:text-brand transition-colors truncate">{theater.currentShow.title}</h3>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-gray-500">
                    <FormatPill type={theater.currentShow.type} />
                    {theater.currentShow.isRevival && <ProductionPill isRevival />}
                    <StatusBadge status={theater.currentShow.status} />
                    {(() => {
                      const duration = getBroadwayDuration(
                        theater.currentShow!.openingDate || theater.currentShow!.previewsStartDate || '',
                        'off-Broadway'
                      );
                      return duration ? <span className="text-gray-500">{duration}</span> : null;
                    })()}
                  </div>
                </div>
                {(() => {
                  const score = theater.currentShow!.criticScore?.score;
                  const tier = getScoreTier(score ?? null);
                  return (
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <ScoreBadge score={score} size="md" showCrown status={theater.currentShow!.status} />
                      {tier && (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                          style={{ color: tier.color }}
                          title={tier.tooltip}
                        >
                          {tier.label}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </Link>
          )}

          {/* Placeholder note for missing venue metadata */}
          <div className="card p-4 mb-4 border border-white/5">
            <p className="text-sm text-gray-400 leading-relaxed">
              Venue details for {theater.name} — capacity, accessibility, and seating tips — are coming soon. We&apos;re enriching all Off-Broadway venues after launch.
            </p>
          </div>
        </div>

        {/* Show list with sort/toggle (reuses Broadway component) */}
        <h2 className="text-lg font-bold text-white mb-1">All Shows</h2>
        <p className="text-xs text-gray-500 mb-3">Covers Off-Broadway productions in our database.</p>
        <TheaterDetailClient shows={theaterShows} />
      </div>
    </>
  );
}
