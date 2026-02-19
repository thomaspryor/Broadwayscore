import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getTheaterBySlug, getAllTheaterSlugs } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceGrade } from '@/lib/data-audience';
import { generateBreadcrumbSchema, generateTheaterSchema, BASE_URL } from '@/lib/seo';
import { ScoreBadge } from '@/components/show-cards';
import TheaterDetailClient from './TheaterDetailClient';

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
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: `${theater.name} - Broadway Theater` }],
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
        ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount }
        : undefined,
      audienceCombinedScore: buzz?.combinedScore ?? null,
      audienceGrade: buzz ? getAudienceGrade(buzz.combinedScore) : null,
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, theaterSchema]).replace(/</g, '\\u003c') }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
          <ol className="flex items-center gap-1.5 flex-wrap">
            <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
            <li className="before:content-['/'] before:mx-1.5"><Link href="/theater" className="hover:text-brand transition-colors">Theaters</Link></li>
            <li className="before:content-['/'] before:mx-1.5 text-gray-300 truncate" aria-current="page">{theater.name}</li>
          </ol>
        </nav>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-lg bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
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
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Shows Tracked</p>
              <p className="text-xl sm:text-2xl font-bold text-white">{theater.allShows.length}</p>
            </div>
            <div className="card p-3 sm:p-4 text-center">
              <p className="text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider mb-1">Avg Score</p>
              <div className="flex justify-center">
                <ScoreBadge score={avgScore ?? undefined} size="sm" />
              </div>
            </div>
          </div>

          {/* Tips */}
          {theater.tips && (
            <div className="card p-4 mb-4 border border-white/5">
              <p className="text-sm text-gray-300 leading-relaxed">{theater.tips}</p>
            </div>
          )}
        </div>

        {/* Show list with sort/toggle */}
        <h2 className="text-lg font-bold text-white mb-3">All Shows</h2>
        <TheaterDetailClient shows={theaterShows} />
      </div>
    </>
  );
}
