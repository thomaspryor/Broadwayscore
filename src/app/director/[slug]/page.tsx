import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getDirectorBySlug, getAllDirectorSlugs } from '@/lib/data';
import { generateBreadcrumbSchema, generatePersonSchema } from '@/lib/seo';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

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
    title: `${director.name} - Broadway Director | BroadwayMetaScores`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
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

export default function DirectorPage({ params }: { params: { slug: string } }) {
  const director = getDirectorBySlug(params.slug);

  if (!director) {
    notFound();
  }

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

  // Sort shows by opening date (newest first)
  const sortedShows = [...director.shows].sort((a, b) =>
    new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime()
  );

  const openShows = sortedShows.filter(s => s.status === 'open');
  const closedShows = sortedShows.filter(s => s.status === 'closed');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, personSchema]) }}
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
          <p className="text-brand text-sm font-medium uppercase tracking-wider mb-2">Director</p>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4">{director.name}</h1>

          {/* Stats */}
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-gray-500 text-sm">Shows Directed</p>
              <p className="text-2xl font-bold text-white">{director.showCount}</p>
            </div>
            {director.avgScore && (
              <div>
                <p className="text-gray-500 text-sm">Average Score</p>
                <div className="flex items-center gap-2 mt-1">
                  <ScoreBadge score={director.avgScore} size="sm" />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Currently Running */}
        {openShows.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-open"></span>
              Currently Running
            </h2>
            <div className="space-y-3">
              {openShows.map(show => (
                <Link
                  key={show.id}
                  href={`/show/${show.slug}`}
                  className="card p-4 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group"
                >
                  {/* Thumbnail */}
                  <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img
                        src={show.images.thumbnail}
                        alt={`${show.title} poster`}
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
                      {show.venue} • Opened {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </p>
                  </div>

                  {/* Score */}
                  <ScoreBadge score={show.criticScore?.score} size="sm" />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Past Shows */}
        {closedShows.length > 0 && (
          <section>
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-500"></span>
              Past Productions
            </h2>
            <div className="space-y-3">
              {closedShows.map(show => (
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
                        alt={`${show.title} poster`}
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
                      {show.venue} • {new Date(show.openingDate).getFullYear()}
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
        {director.shows.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found for this director.</p>
          </div>
        )}
      </div>
    </>
  );
}
