import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTopShowsByCategory, getAllShows } from '@/lib/data';

type CategoryConfig = {
  title: string;
  description: string;
  type: 'musicals' | 'plays' | 'all';
};

const categories: Record<string, CategoryConfig> = {
  musicals: {
    title: 'Best Broadway Musicals',
    description: 'The highest-rated Broadway musicals based on critic reviews and metascores.',
    type: 'musicals',
  },
  plays: {
    title: 'Best Broadway Plays',
    description: 'The highest-rated Broadway plays based on critic reviews and metascores.',
    type: 'plays',
  },
  all: {
    title: 'Best Broadway Shows',
    description: 'The highest-rated Broadway shows of all types based on critic reviews and metascores.',
    type: 'all',
  },
};

export async function generateStaticParams() {
  return Object.keys(categories).map(category => ({ category }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const config = categories[category];

  if (!config) return { title: 'Not Found' };

  return {
    title: `${config.title} | Broadway Metascore`,
    description: config.description,
    openGraph: {
      title: config.title,
      description: config.description,
    },
  };
}

function ScoreBadge({ score }: { score?: number | null }) {
  if (score === undefined || score === null) {
    return (
      <div className="w-12 h-12 rounded-lg bg-gray-800 flex items-center justify-center text-gray-500 font-bold text-lg">
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
    <div className={`w-12 h-12 rounded-lg ${colorClass} flex items-center justify-center font-bold text-lg`}>
      {roundedScore}
    </div>
  );
}

export default async function BestCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const config = categories[category];

  if (!config) {
    notFound();
  }

  const shows = getTopShowsByCategory(config.type, 20);

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

        <h1 className="text-3xl font-bold text-white mb-2">{config.title}</h1>
        <p className="text-gray-400 mb-8">{config.description}</p>

        {shows.length === 0 ? (
          <p className="text-gray-500">No scored shows in this category yet.</p>
        ) : (
          <div className="space-y-4">
            {shows.map((show, index) => (
              <Link
                key={show.id}
                href={`/show/${show.slug}`}
                className="flex items-center gap-4 p-4 bg-surface rounded-xl hover:bg-surface-elevated transition-colors"
              >
                <span className="text-2xl font-bold text-gray-500 w-8 text-center">
                  {index + 1}
                </span>
                <ScoreBadge score={show.metascore} />
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-white truncate">{show.title}</h2>
                  <p className="text-sm text-gray-400">
                    {show.venue} • {show.type === 'musical' ? 'Musical' : 'Play'}
                  </p>
                </div>
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    show.status === 'open'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-500/20 text-gray-400'
                  }`}
                >
                  {show.status === 'open' ? 'Now Playing' : 'Closed'}
                </span>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-12 pt-8 border-t border-gray-800">
          <h2 className="text-lg font-semibold text-white mb-4">Browse by Category</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(categories).map(([key, cat]) => (
              <Link
                key={key}
                href={`/best/${key}`}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  key === category
                    ? 'bg-brand text-white'
                    : 'bg-surface text-gray-400 hover:bg-surface-elevated hover:text-white'
                }`}
              >
                {cat.title.replace('Best Broadway ', '')}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
