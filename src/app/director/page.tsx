import Link from 'next/link';
import { Metadata } from 'next';
import { getAllDirectors } from '@/lib/data';
import { generateBreadcrumbSchema } from '@/lib/seo';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore-ayv17ggvd-thomaspryors-projects.vercel.app';

export const metadata: Metadata = {
  title: 'Broadway Directors - All Directors & Their Shows',
  description: 'Browse all Broadway directors and see their shows with critic scores. Find productions by your favorite theater directors.',
  alternates: {
    canonical: `${BASE_URL}/director`,
  },
  openGraph: {
    title: 'Broadway Directors',
    description: 'Browse all Broadway directors and their productions with critic scores.',
    url: `${BASE_URL}/director`,
  },
};

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <span className="text-gray-500 text-sm">—</span>
    );
  }

  const colorClass = score >= 70
    ? 'text-score-high'
    : score >= 50
    ? 'text-score-medium'
    : 'text-score-low';

  return (
    <span className={`font-bold ${colorClass}`}>{score}</span>
  );
}

export default function DirectorsIndexPage() {
  const directors = getAllDirectors();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Directors', url: `${BASE_URL}/director` },
  ]);

  // Group directors by first letter
  const grouped = directors.reduce((acc, director) => {
    const letter = director.name[0].toUpperCase();
    if (!acc[letter]) acc[letter] = [];
    acc[letter].push(director);
    return acc;
  }, {} as Record<string, typeof directors>);

  const letters = Object.keys(grouped).sort();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            All Shows
          </Link>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Directors</h1>
          <p className="text-gray-400 mt-2">
            {directors.length} directors with shows in our database
          </p>
        </div>

        {/* Letter navigation */}
        <div className="flex flex-wrap gap-2 mb-8">
          {letters.map(letter => (
            <a
              key={letter}
              href={`#letter-${letter}`}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-raised text-gray-400 hover:text-brand hover:bg-surface-overlay transition-colors text-sm font-medium"
            >
              {letter}
            </a>
          ))}
        </div>

        {/* Directors list */}
        <div className="space-y-8">
          {letters.map(letter => (
            <section key={letter} id={`letter-${letter}`}>
              <h2 className="text-xl font-bold text-white mb-4 sticky top-16 bg-surface-dark/95 backdrop-blur py-2 -mx-4 px-4">
                {letter}
              </h2>
              <div className="grid gap-3">
                {grouped[letter].map(director => (
                  <Link
                    key={director.slug}
                    href={`/director/${director.slug}`}
                    className="card p-4 flex items-center justify-between hover:bg-surface-raised/80 transition-colors group"
                  >
                    <div>
                      <h3 className="font-semibold text-white group-hover:text-brand transition-colors">
                        {director.name}
                      </h3>
                      <p className="text-gray-500 text-sm">
                        {director.showCount} {director.showCount === 1 ? 'show' : 'shows'}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-500">Avg Score</div>
                      <ScoreBadge score={director.avgScore} />
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
