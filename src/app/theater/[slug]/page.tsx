import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getTheaterBySlug, getAllTheaterSlugs } from '@/lib/data';
import { generateBreadcrumbSchema, generateTheaterSchema } from '@/lib/seo';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

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
  const description = `${theater.name} on Broadway. ${currentShowText} See all shows, scores, and theater details.`;

  return {
    title: `${theater.name} - Broadway Theater | BroadwayMetaScores`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${theater.name} - Broadway Theater`,
      description,
      url: canonicalUrl,
      type: 'place',
    },
    twitter: {
      card: 'summary',
      title: `${theater.name} - Broadway Theater`,
      description,
    },
  };
}

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' }) {
  const sizeClasses = {
    sm: 'w-10 h-10 text-sm rounded-lg',
    md: 'w-12 h-12 text-lg rounded-xl',
  };

  if (score === undefined || score === null) {
    return (
      <div className={`${sizeClasses[size]} bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const colorClass = roundedScore >= 70
    ? 'bg-score-high text-white'
    : roundedScore >= 50
    ? 'bg-score-medium text-gray-900'
    : 'bg-score-low text-white';

  return (
    <div className={`${sizeClasses[size]} ${colorClass} flex items-center justify-center font-bold`}>
      {roundedScore}
    </div>
  );
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export default function TheaterPage({ params }: { params: { slug: string } }) {
  const theater = getTheaterBySlug(params.slug);

  if (!theater) {
    notFound();
  }

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

  const pastShows = theater.allShows.filter(s => s.status === 'closed');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, theaterSchema]) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="mb-8">
          <p className="text-brand text-sm font-medium uppercase tracking-wider mb-2">Broadway Theater</p>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4">{theater.name}</h1>

          {/* Address & Map */}
          {theater.address && (
            <div className="flex items-start gap-3 text-gray-400">
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <div>
                <p>{theater.address}</p>
                <a
                  href={getGoogleMapsUrl(theater.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:text-brand-hover text-sm inline-flex items-center gap-1 mt-1"
                >
                  View on Google Maps
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="flex gap-6 mt-6">
            <div>
              <p className="text-gray-500 text-sm">Total Shows</p>
              <p className="text-2xl font-bold text-white">{theater.showCount}</p>
            </div>
          </div>
        </div>

        {/* Now Playing */}
        {theater.currentShow && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-open animate-pulse"></span>
              Now Playing
            </h2>
            <Link
              href={`/show/${theater.currentShow.slug}`}
              className="card p-5 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group border-2 border-status-open/30"
            >
              {/* Thumbnail */}
              <div className="w-20 h-20 rounded-xl overflow-hidden bg-surface-overlay flex-shrink-0">
                {theater.currentShow.images?.thumbnail ? (
                  <img
                    src={theater.currentShow.images.thumbnail}
                    alt={`${theater.currentShow.title} - now playing at ${theater.name}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-2xl">🎭</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <h3 className="text-xl font-bold text-white group-hover:text-brand transition-colors">
                  {theater.currentShow.title}
                </h3>
                <p className="text-gray-400 text-sm mt-1">
                  {theater.currentShow.type === 'musical' ? 'Musical' : 'Play'} •
                  Opened {new Date(theater.currentShow.openingDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
                {theater.currentShow.criticScore && (
                  <p className="text-gray-500 text-sm mt-1">
                    {theater.currentShow.criticScore.reviewCount} critic reviews
                  </p>
                )}
              </div>

              {/* Score */}
              <ScoreBadge score={theater.currentShow.criticScore?.score} />
            </Link>
          </section>
        )}

        {/* Show History */}
        {pastShows.length > 0 && (
          <section>
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-500"></span>
              Show History
            </h2>
            <div className="space-y-3">
              {pastShows.map(show => (
                <Link
                  key={show.id}
                  href={`/show/${show.slug}`}
                  className="card p-4 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group opacity-75 hover:opacity-100"
                >
                  {/* Thumbnail */}
                  <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img
                        src={show.images.thumbnail}
                        alt={`${show.title} - previously at ${theater.name}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-xl">🎭</span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate">
                      {show.title}
                    </h3>
                    <p className="text-gray-400 text-sm">
                      {new Date(show.openingDate).getFullYear()}
                      {show.closingDate && ` – ${new Date(show.closingDate).getFullYear()}`}
                    </p>
                  </div>

                  {/* Score */}
                  <ScoreBadge score={show.criticScore?.score} size="sm" />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Empty State */}
        {theater.allShows.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found for this theater.</p>
          </div>
        )}
      </div>
    </>
  );
}
