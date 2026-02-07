import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getTheaterBySlug, getAllTheaterSlugs } from '@/lib/data-core';
import { generateBreadcrumbSchema, generateTheaterSchema } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

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
    title: `${theater.name} - Broadway Theater`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${theater.name} - Broadway Theater`,
      description,
      url: canonicalUrl,
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: `${theater.name} - Broadway Theater`,
      description,
    },
  };
}

function ScoreBadge({ score }: { score?: number | null }) {
  if (score === undefined || score === null) {
    return (
      <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay text-gray-600 border border-white/5 flex items-center justify-center font-bold">
        —
      </div>
    );
  }
  const r = Math.round(score);
  let c: string;
  if (r >= 85) c = 'score-must-see';
  else if (r >= 75) c = 'score-great';
  else if (r >= 65) c = 'score-good';
  else if (r >= 55) c = 'score-tepid';
  else c = 'score-skip';
  return (
    <div className={`w-10 h-10 text-sm rounded-lg ${c} flex items-center justify-center font-bold`}>
      {r}
    </div>
  );
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

  const openShows = theater.allShows.filter(s => s.status === 'open' || s.status === 'previews');
  const closedShows = [...theater.allShows.filter(s => s.status === 'closed')]
    .sort((a, b) => new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime());

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, theaterSchema]) }}
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
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-lg bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{theater.name}</h1>
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
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Total Shows</p>
              <p className="text-2xl font-bold text-white">{theater.showCount}</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Now Playing</p>
              <p className="text-2xl font-bold text-white">{openShows.length || '—'}</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Past Shows</p>
              <p className="text-2xl font-bold text-white">{closedShows.length}</p>
            </div>
          </div>
        </div>

        {/* Now Playing */}
        {openShows.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-open animate-pulse" />
              Now Playing
            </h2>
            <div className="space-y-2">
              {openShows.map(show => (
                <Link key={show.id} href={`/show/${show.slug}`}
                  className="card p-4 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group border border-status-open/20">
                  <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')} alt={show.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><span className="text-xl">🎭</span></div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate">{show.title}</h3>
                    <p className="text-gray-500 text-sm mt-0.5">
                      {show.type === 'musical' ? 'Musical' : 'Play'} · Opened {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <ScoreBadge score={show.criticScore?.score} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Show History */}
        {closedShows.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-white mb-3">Show History</h2>
            <div className="space-y-2">
              {closedShows.map(show => (
                <Link key={show.id} href={`/show/${show.slug}`}
                  className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group">
                  <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')} alt={show.title} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><span className="text-lg sm:text-xl">🎭</span></div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">{show.title}</h3>
                    <p className="text-gray-500 text-xs sm:text-sm mt-0.5">
                      {new Date(show.openingDate).getFullYear()}{show.closingDate && ` – ${new Date(show.closingDate).getFullYear()}`} · {show.type === 'musical' ? 'Musical' : 'Play'}
                    </p>
                  </div>
                  <ScoreBadge score={show.criticScore?.score} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {theater.allShows.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found for this theater.</p>
          </div>
        )}
      </div>
    </>
  );
}
