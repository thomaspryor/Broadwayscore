import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBestOfList, getAllBestOfCategories, BestOfCategory } from '@/lib/data';
import { generateBreadcrumbSchema, generateItemListSchema } from '@/lib/seo';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore-ayv17ggvd-thomaspryors-projects.vercel.app';

export function generateStaticParams() {
  return getAllBestOfCategories().map((category) => ({ category }));
}

export function generateMetadata({ params }: { params: { category: string } }): Metadata {
  const list = getBestOfList(params.category as BestOfCategory);
  if (!list) return { title: 'List Not Found' };

  const canonicalUrl = `${BASE_URL}/best/${params.category}`;

  return {
    title: `${list.title} 2026 | BroadwayMetaScores`,
    description: list.description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: list.title,
      description: list.description,
      url: canonicalUrl,
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: list.title,
      description: list.description,
    },
  };
}

function ScoreBadge({ score }: { score?: number | null }) {
  if (score === undefined || score === null) {
    return (
      <div className="w-12 h-12 bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-bold text-lg rounded-xl">
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
    <div className={`w-12 h-12 ${colorClass} flex items-center justify-center font-bold text-lg rounded-xl`}>
      {roundedScore}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

export default function BestOfPage({ params }: { params: { category: string } }) {
  const list = getBestOfList(params.category as BestOfCategory);

  if (!list) {
    notFound();
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Best Of', url: `${BASE_URL}/best` },
    { name: list.title, url: `${BASE_URL}/best/${params.category}` },
  ]);

  const itemListSchema = generateItemListSchema(
    list.shows.map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
    })),
    list.title
  );

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
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
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">{list.title}</h1>
          <p className="text-gray-400 text-lg">{list.description}</p>
          <p className="text-gray-500 text-sm mt-2">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Show List */}
        {list.shows.length > 0 ? (
          <div className="space-y-4">
            {list.shows.map((show, index) => (
              <Link
                key={show.id}
                href={`/show/${show.slug}`}
                className="card p-4 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group"
              >
                <RankBadge rank={index + 1} />

                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                  {show.images?.thumbnail ? (
                    <img
                      src={show.images.thumbnail}
                      alt={`${show.title} Broadway ${show.type}`}
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
                  <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate">
                    {show.title}
                  </h2>
                  <p className="text-gray-400 text-sm truncate">
                    {show.venue} • {show.type === 'musical' ? 'Musical' : 'Play'}
                  </p>
                  {show.criticScore && (
                    <p className="text-gray-500 text-xs mt-1">
                      {show.criticScore.reviewCount} reviews
                    </p>
                  )}
                </div>

                {/* Score */}
                <ScoreBadge score={show.criticScore?.score} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="card p-8 text-center">
            <p className="text-gray-400">No shows found in this category.</p>
          </div>
        )}

        {/* Other Lists */}
        <div className="mt-12 pt-8 border-t border-white/10">
          <h3 className="text-lg font-bold text-white mb-4">Explore More Lists</h3>
          <div className="flex flex-wrap gap-2">
            {getAllBestOfCategories()
              .filter(cat => cat !== params.category)
              .map(cat => {
                const otherList = getBestOfList(cat);
                return otherList ? (
                  <Link
                    key={cat}
                    href={`/best/${cat}`}
                    className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    {otherList.title.replace('Best ', '').replace('Top 10 ', '')}
                  </Link>
                ) : null;
              })}
          </div>
        </div>
      </div>
    </>
  );
}
