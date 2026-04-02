import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getTheaterBySlug, getAllTheaterSlugs } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateTheaterSchema, BASE_URL } from '@/lib/seo';
import { ScoreBadge, FormatPill, ProductionPill, StatusBadge, getScoreTier } from '@/components/show-cards';
import { getOptimizedImageUrl } from '@/lib/images';
import { getBroadwayDuration } from '@/lib/date-utils';
import TheaterDetailClient from './TheaterDetailClient';
import TheaterTipsCard from '@/components/TheaterTipsCard';
import TheaterScorecardCard from '@/components/TheaterScorecardCard';
import { featureFlags } from '@/config/feature-flags';
import Breadcrumb from '@/components/Breadcrumb';

export function generateStaticParams() {
  return getAllTheaterSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const theater = getTheaterBySlug(params.slug);
  if (!theater) return { title: 'Theater Not Found' };

  const canonicalUrl = `${BASE_URL}/theater/${params.slug}`;
  const currentShowText = theater.currentShow
    ? `Currently showing: ${theater.currentShow.title}.`
    : 'View show history and information.';
  const capacityText = theater.capacity ? ` ${theater.capacity.toLocaleString()} seats.` : '';
  const description = `${theater.name} on Broadway.${capacityText} ${currentShowText} See all ${theater.showCount} shows, scores, and theater details.`;

  return {
    title: `${theater.name} - Broadway Theater`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${theater.name} - Broadway Theater`,
      description,
      url: canonicalUrl,
      type: 'website',
      images: [{ url: theater.images?.exterior ? getWikimediaThumbUrl(theater.images.exterior, 1200) : `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: `${theater.name} - Broadway Theater` }],
    },
    twitter: {
      card: 'summary',
      title: `${theater.name} - Broadway Theater`,
      description,
    },
  };
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Convert Wikimedia original URL to width-based thumb URL */
function getWikimediaThumbUrl(originalUrl: string, width: number): string {
  if (!originalUrl.includes('/commons/') || originalUrl.includes('/thumb/')) return originalUrl;
  const parts = originalUrl.split('/commons/');
  const path = parts[1];
  const filename = path.split('/').pop();
  return `${parts[0]}/commons/thumb/${path}/${width}px-${filename}`;
}

export default function TheaterPage({ params }: { params: { slug: string } }) {
  const theater = getTheaterBySlug(params.slug);
  if (!theater) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Theaters', url: `${BASE_URL}/theater` },
    { name: theater.name, url: `${BASE_URL}/theater/${params.slug}` },
  ]);

  const theaterSchema = generateTheaterSchema({
    name: theater.name,
    slug: theater.slug,
    address: theater.address,
    currentShow: theater.currentShow ? {
      title: theater.currentShow.title,
      slug: theater.currentShow.slug,
    } : undefined,
    pastShows: theater.allShows
      .filter(s => s.status === 'closed')
      .map(s => ({ title: s.title, slug: s.slug })),
  });

  // FAQ schema — only include questions for data that exists (avoids undefined in static build)
  const theaterFaqQuestions: { name: string; text: string }[] = [];
  if (theater.currentShow) {
    theaterFaqQuestions.push({
      name: `What show is currently playing at ${theater.name}?`,
      text: `${theater.currentShow.title} is currently playing at ${theater.name}.${theater.address ? ` The theater is located at ${theater.address}.` : ''}`,
    });
  }
  if (theater.capacity) {
    theaterFaqQuestions.push({
      name: `How many seats does ${theater.name} have?`,
      text: `${theater.name} has a seating capacity of ${theater.capacity.toLocaleString()}.`,
    });
  }
  theaterFaqQuestions.push({
    name: `How many shows have played at ${theater.name}?`,
    text: `${theater.showCount} shows have played at ${theater.name}.`,
  });

  const theaterFaqSchema = theaterFaqQuestions.length >= 2 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: theaterFaqQuestions.map(q => ({
      '@type': 'Question',
      name: q.name,
      acceptedAnswer: { '@type': 'Answer', text: q.text },
    })),
  } : null;

  // Compute stats
  const pastShowCount = theater.allShows.filter(s => s.status === 'closed').length;
  const scoredShows = theater.allShows.filter(s => s.criticScore?.score != null);
  const avgScore = scoredShows.length > 0
    ? Math.round(scoredShows.reduce((sum, s) => sum + (s.criticScore?.score ?? 0), 0) / scoredShows.length)
    : null;

  // Serialize shows for client component
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
        ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount, tier1Count: show.criticScore.tier1Count, tier2Count: show.criticScore.tier2Count }
        : undefined,
      audienceCombinedScore: buzz && hasEnoughAudienceReviews(buzz) ? buzz.combinedScore : null,
      audienceGrade: buzz && hasEnoughAudienceReviews(buzz) ? getAudienceGrade(buzz.combinedScore) : null,
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, theaterSchema, ...(theaterFaqSchema ? [theaterFaqSchema] : [])]).replace(/</g, '\\u003c') }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: 'Theaters', href: '/theater' },
          { label: theater.name },
        ]} />

        {/* Header */}
        <div className="mb-6">
          {/* Hero image */}
          {theater.images?.exterior && (
            <div className="mb-4">
              <div className="relative rounded-xl overflow-hidden" style={{ maxHeight: '240px' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={getWikimediaThumbUrl(theater.images.exterior, 800)}
                  alt={`${theater.name} exterior`}
                  className="w-full h-full object-cover"
                  style={{ maxHeight: '240px' }}
                  loading="eager"
                />
              </div>
              {theater.images.attribution && (
                <p className="text-[10px] text-gray-600 mt-1 text-right">Photo: {theater.images.attribution}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 mb-3">
            {!theater.images?.exterior && (
              <div className="w-12 h-12 rounded-lg bg-surface-overlay flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
            )}
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{theater.name}</h1>
              {theater.formerNames && theater.formerNames.length > 0 && (
                <p className="text-gray-500 text-xs mt-0.5">Formerly {theater.formerNames.join(', ')}</p>
              )}
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
                {theater.operator && (
                  <span className="text-gray-500 text-xs">{theater.operator}</span>
                )}
                <Link href="/broadway-theaters-map" className="text-gray-500 text-xs hover:text-brand transition-colors">View on Map</Link>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className={`grid ${theater.capacity ? 'grid-cols-3' : 'grid-cols-2'} gap-3 mb-4`}>
            {theater.capacity && (
              <div className="card p-3 sm:p-4 text-center">
                <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Seats</p>
                <p className="text-xl sm:text-2xl font-bold text-white">{theater.capacity.toLocaleString()}</p>
              </div>
            )}
            <div className="card p-3 sm:p-4 text-center">
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Past Shows</p>
              <p className="text-xl sm:text-2xl font-bold text-white">{theater.allShows.length}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">1970 – present</p>
            </div>
            <div className="card p-3 sm:p-4 text-center">
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Avg Score</p>
              <div className="flex justify-center">
                <ScoreBadge score={avgScore ?? undefined} size="sm" />
              </div>
            </div>
          </div>

          {/* Now Playing — prominent current show card */}
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
                      const duration = getBroadwayDuration(theater.currentShow!.openingDate || theater.currentShow!.previewsStartDate || '');
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

          {/* Theater Scorecard */}
          {featureFlags.theaterScorecard && theater.venueScores && (
            <TheaterScorecardCard
              venueScores={theater.venueScores}
              accessibility={theater.accessibility}
              externalLinks={theater.externalLinks}
              theaterName={theater.name}
              theaterSlug={theater.slug}
            />
          )}

          {/* Tips */}
          {theater.structuredTips ? (
            <TheaterTipsCard tips={theater.structuredTips} fallbackTips={theater.tips} />
          ) : theater.tips ? (
            <div className="card p-4 mb-4 border border-white/5">
              <p className="text-sm text-gray-300 leading-relaxed">{theater.tips}</p>
            </div>
          ) : null}
        </div>

        {/* Show list with sort/toggle */}
        <h2 className="text-lg font-bold text-white mb-1">All Shows</h2>
        <p className="text-xs text-gray-500 mb-3">Covers productions from 1970 to present. Critic scores available from 2005.</p>
        <TheaterDetailClient shows={theaterShows} />
      </div>
    </>
  );
}
