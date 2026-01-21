import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAllTheaters, getTheaterBySlug } from '@/lib/data';

export async function generateStaticParams() {
  const theaters = getAllTheaters();
  return theaters.map(theater => ({ slug: theater.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const theater = getTheaterBySlug(slug);

  if (!theater) return { title: 'Not Found' };

  return {
    title: `${theater.name} | Broadway Metascore`,
    description: `Broadway shows at ${theater.name}. See reviews, scores, and what's playing.`,
    openGraph: {
      title: `${theater.name} - Broadway Theater`,
      description: `Broadway shows at ${theater.name}. See reviews, scores, and what's playing.`,
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

export default async function TheaterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const theater = getTheaterBySlug(slug);

  if (!theater) {
    notFound();
  }

  const openShows = theater.shows.filter(s => s.status === 'open');
  const closedShows = theater.shows.filter(s => s.status === 'closed');

  // Get theater address from first show that has it
  const theaterAddress = theater.shows.find(s => s.theaterAddress)?.theaterAddress;

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

        <h1 className="text-3xl font-bold text-white mb-2">{theater.name}</h1>
        {theaterAddress && (
          <p className="text-gray-400 mb-2">{theaterAddress}</p>
        )}
        <p className="text-gray-500 mb-8">
          {theater.shows.length} show{theater.shows.length !== 1 ? 's' : ''} tracked
        </p>

        {openShows.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              Now Playing
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
                      {show.type === 'musical' ? 'Musical' : 'Play'}
                      {show.runtime && ` • ${show.runtime}`}
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
              Previously at this Theater
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
                      {show.type === 'musical' ? 'Musical' : 'Play'}
                      {show.closingDate && ` • Closed ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mt-12 pt-8 border-t border-gray-800">
          <h2 className="text-lg font-semibold text-white mb-4">Other Broadway Theaters</h2>
          <div className="flex flex-wrap gap-2">
            {getAllTheaters()
              .filter(t => t.slug !== slug)
              .slice(0, 10)
              .map(t => (
                <Link
                  key={t.slug}
                  href={`/theater/${t.slug}`}
                  className="px-3 py-1.5 rounded-lg bg-surface text-gray-400 hover:bg-surface-elevated hover:text-white text-sm transition-colors"
                >
                  {t.name}
                </Link>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
