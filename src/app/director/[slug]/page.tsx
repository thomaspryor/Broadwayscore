import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getDirectorBySlug, getAllDirectorSlugs } from '@/lib/data-core';
import { generateBreadcrumbSchema, generatePersonSchema } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateStaticParams() {
  return getAllDirectorSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const director = getDirectorBySlug(params.slug);
  if (!director) return { title: 'Director Not Found' };

  const canonicalUrl = `${BASE_URL}/director/${params.slug}`;
  const description = director.avgScore
    ? `${director.name} has directed ${director.showCount} Broadway show${director.showCount > 1 ? 's' : ''} with an average critic score of ${director.avgScore}/100.`
    : `${director.name} has directed ${director.showCount} Broadway show${director.showCount > 1 ? 's' : ''}. See their full Broadway history.`;

  return {
    title: `${director.name} - Broadway Director`,
    description,
    alternates: { canonical: canonicalUrl },
    robots: { index: false, follow: true },
    openGraph: {
      title: `${director.name} - Broadway Director`,
      description,
      url: canonicalUrl,
      type: 'profile',
    },
    twitter: {
      card: 'summary',
      title: `${director.name} - Broadway Director`,
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

function getScoreTextColor(score: number): string {
  const r = Math.round(score);
  if (r >= 85) return '#FFD700';
  if (r >= 75) return '#22c55e';
  if (r >= 65) return '#14b8a6';
  if (r >= 55) return '#f59e0b';
  return '#ef4444';
}

export default function DirectorPage({ params }: { params: { slug: string } }) {
  const director = getDirectorBySlug(params.slug);
  if (!director) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Directors', url: `${BASE_URL}/director` },
    { name: director.name, url: `${BASE_URL}/director/${params.slug}` },
  ]);

  const personSchema = generatePersonSchema({
    name: director.name,
    slug: director.slug,
    role: 'Director',
    shows: director.shows.map(s => ({
      title: s.title,
      slug: s.slug,
      score: s.criticScore?.score ? Math.round(s.criticScore.score) : undefined,
    })),
  });

  const sortedShows = [...director.shows].sort((a, b) =>
    new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime()
  );

  const openShows = sortedShows.filter(s => s.status === 'open' || s.status === 'previews');
  const closedShows = sortedShows.filter(s => s.status === 'closed');

  const scoredShows = director.shows.filter(s => s.criticScore?.score != null);
  const highScore = scoredShows.length > 0 ? Math.round(Math.max(...scoredShows.map(s => s.criticScore!.score!))) : null;
  const lowScore = scoredShows.length > 0 ? Math.round(Math.min(...scoredShows.map(s => s.criticScore!.score!))) : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, personSchema]) }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
          <ol className="flex items-center gap-1.5 flex-wrap">
            <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
            <li className="before:content-['/'] before:mx-1.5"><Link href="/director" className="hover:text-brand transition-colors">Directors</Link></li>
            <li className="before:content-['/'] before:mx-1.5 text-gray-300 truncate" aria-current="page">{director.name}</li>
          </ol>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-lg">
                {director.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">{director.name}</h1>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Shows</p>
              <p className="text-2xl font-bold text-white">{director.showCount}</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Average</p>
              <p className="text-2xl font-bold" style={director.avgScore ? { color: getScoreTextColor(director.avgScore) } : undefined}>
                {director.avgScore ? Math.round(director.avgScore) : '—'}
              </p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Highest</p>
              <p className="text-2xl font-bold text-white">{highScore ?? '—'}</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Lowest</p>
              <p className="text-2xl font-bold text-white">{lowScore ?? '—'}</p>
            </div>
          </div>
        </div>

        {/* Currently Running */}
        {openShows.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-open animate-pulse" />
              Currently Running
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
                    <p className="text-gray-500 text-sm mt-0.5">{show.venue} · {show.type === 'musical' ? 'Musical' : 'Play'}</p>
                  </div>
                  <ScoreBadge score={show.criticScore?.score} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Past Productions */}
        {closedShows.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-white mb-3">Past Productions</h2>
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
                      {show.venue} · {new Date(show.openingDate).getFullYear()}{show.closingDate && `–${new Date(show.closingDate).getFullYear()}`}
                    </p>
                  </div>
                  <ScoreBadge score={show.criticScore?.score} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {director.shows.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found for this director.</p>
          </div>
        )}
      </div>
    </>
  );
}
