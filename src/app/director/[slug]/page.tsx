import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAllDirectors, getDirectorBySlug } from '@/lib/data';

export async function generateStaticParams() {
  const directors = getAllDirectors();
  return directors.map(director => ({ slug: director.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const director = getDirectorBySlug(slug);

  if (!director) return { title: 'Not Found' };

  return {
    title: `${director.name} - Broadway Director | Broadway Metascore`,
    description: `Broadway shows directed by ${director.name}. See reviews, scores, and productions.`,
    openGraph: {
      title: `${director.name} - Broadway Director`,
      description: `Broadway shows directed by ${director.name}. See reviews, scores, and productions.`,
    },
  };
}

function ScoreBadge({ score }: { score?: number | null }) {
  if (score === undefined || score === null) {
    return (
      <div className="w-11 h-11 rounded-lg bg-gray-800 flex items-center justify-center text-gray-500 font-bold">
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const colorClass =
    roundedScore >= 70
      ? 'bg-green-500 text-white'
      : roundedScore >= 50
      ? 'bg-yellow-500 text-black'
      : 'bg-red-500 text-white';

  return (
    <div className={`w-11 h-11 rounded-lg ${colorClass} flex items-center justify-center font-bold`}>
      {roundedScore}
    </div>
  );
}

export default async function DirectorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const director = getDirectorBySlug(slug);

  if (!director) {
    notFound();
  }

  const openShows = director.shows.filter(s => s.status === 'open');
  const closedShows = director.shows.filter(s => s.status === 'closed');

  // Calculate average score
  const scoredShows = director.shows.filter(s => s.metascore !== null && s.metascore !== undefined);
  const avgScore = scoredShows.length > 0
    ? Math.round(scoredShows.reduce((sum, s) => sum + (s.metascore ?? 0), 0) / scoredShows.length)
    : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link
          href="/"
          className="inline-flex items-center text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to all shows
        </Link>

        <div className="flex items-start gap-6 mb-8">
          <div className="w-20 h-20 rounded-full bg-surface flex items-center justify-center text-3xl font-bold text-brand">
            {director.name.charAt(0)}
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white mb-1">{director.name}</h1>
            <p className="text-gray-400">Broadway Director</p>
            <div className="flex items-center gap-4 mt-3 text-sm">
              <span className="text-gray-500">
                {director.shows.length} production{director.shows.length !== 1 ? 's' : ''}
              </span>
              {avgScore !== null && (
                <span className="text-gray-500">
                  Avg. Score: <span className="text-white font-semibold">{avgScore}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {openShows.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              Currently Running
            </h2>
            <div className="space-y-3">
              {openShows.map(show => (
                <Link
                  key={show.id}
                  href={`/show/${show.slug}`}
                  className="flex items-center gap-4 p-4 bg-surface rounded-xl hover:bg-surface-elevated transition-colors"
                >
                  <ScoreBadge score={show.metascore} />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white truncate">{show.title}</h3>
                    <p className="text-sm text-gray-400">
                      {show.venue} • {show.type === 'musical' ? 'Musical' : 'Play'}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {closedShows.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-500"></span>
              Past Productions
            </h2>
            <div className="space-y-3">
              {closedShows.map(show => (
                <Link
                  key={show.id}
                  href={`/show/${show.slug}`}
                  className="flex items-center gap-4 p-4 bg-surface rounded-xl hover:bg-surface-elevated transition-colors opacity-75"
                >
                  <ScoreBadge score={show.metascore} />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white truncate">{show.title}</h3>
                    <p className="text-sm text-gray-400">
                      {show.venue}
                      {show.closingDate && ` • Closed ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mt-12 pt-8 border-t border-gray-800">
          <h2 className="text-lg font-semibold text-white mb-4">Other Broadway Directors</h2>
          <div className="flex flex-wrap gap-2">
            {getAllDirectors()
              .filter(d => d.slug !== slug)
              .slice(0, 12)
              .map(d => (
                <Link
                  key={d.slug}
                  href={`/director/${d.slug}`}
                  className="px-3 py-1.5 rounded-lg bg-surface text-gray-400 hover:bg-surface-elevated hover:text-white text-sm transition-colors"
                >
                  {d.name}
                </Link>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
