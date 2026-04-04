import { Metadata } from 'next';
import Link from 'next/link';
import { COMPARISON_PAIRS, COMPARISON_CATEGORIES } from '@/config/comparisons';
import { getShowBySlug } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import Breadcrumb from '@/components/Breadcrumb';

export const metadata: Metadata = {
  title: 'Broadway Show Comparisons - Which Show Should You See?',
  description: 'Compare Broadway shows side by side. Hamilton vs Wicked, Lion King vs Aladdin, and more. See CriticScore ratings, runtime, ticket prices to help you decide.',
  alternates: { canonical: `${BASE_URL}/compare` },
  openGraph: {
    title: 'Broadway Show Comparisons - Which Show Should You See?',
    description: 'Compare Broadway shows side by side. Hamilton vs Wicked, Lion King vs Aladdin, and more.',
    url: `${BASE_URL}/compare`,
    type: 'website',
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: 'Broadway Show Comparisons' }],
  },
};

function ComparisonCard({ showA, showB, slug }: {
  showA: NonNullable<ReturnType<typeof getShowBySlug>>;
  showB: NonNullable<ReturnType<typeof getShowBySlug>>;
  slug: string;
}) {
  return (
    <Link
      href={`/compare/${slug}`}
      className="card p-4 hover:bg-surface-raised transition-colors group"
    >
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
          <ShowImage
            sources={[
              showA.images?.thumbnail ? getOptimizedImageUrl(showA.images.thumbnail, 'thumbnail') : null,
              showA.images?.poster ? getOptimizedImageUrl(showA.images.poster, 'thumbnail') : null,
            ]}
            alt={showA.title}
            className="w-full h-full object-cover"
            fallback={
              <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                <span className="text-2xl text-gray-500">🎭</span>
              </div>
            }
          />
        </div>
        <div className="flex-shrink-0">
          <span className="px-2 py-1 rounded-full bg-brand/20 text-brand text-xs font-bold">VS</span>
        </div>
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
          <ShowImage
            sources={[
              showB.images?.thumbnail ? getOptimizedImageUrl(showB.images.thumbnail, 'thumbnail') : null,
              showB.images?.poster ? getOptimizedImageUrl(showB.images.poster, 'thumbnail') : null,
            ]}
            alt={showB.title}
            className="w-full h-full object-cover"
            fallback={
              <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                <span className="text-2xl text-gray-500">🎭</span>
              </div>
            }
          />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors">
            {showA.title} vs {showB.title}
          </h3>
          <p className="text-gray-400 text-xs sm:text-sm mt-1">
            {showA.type === 'musical' ? 'Musical' : 'Play'} vs {showB.type === 'musical' ? 'Musical' : 'Play'}
            {showA.criticScore?.score && showB.criticScore?.score && (
              <span className="ml-2">
                • Scores: {Math.round(showA.criticScore.score)} vs {Math.round(showB.criticScore.score)}
              </span>
            )}
          </p>
        </div>
        <div className="text-gray-500 group-hover:text-brand transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    </Link>
  );
}

export default function ComparePage() {
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Compare Shows', url: `${BASE_URL}/compare` },
  ]);

  type ComparisonItem = {
    showA: NonNullable<ReturnType<typeof getShowBySlug>>;
    showB: NonNullable<ReturnType<typeof getShowBySlug>>;
    slug: string;
  };

  // Resolve comparison pairs to show data
  const resolvePairs = (pairs: [string, string][]): ComparisonItem[] =>
    pairs.map(([slugA, slugB]) => {
      const showA = getShowBySlug(slugA);
      const showB = getShowBySlug(slugB);
      if (!showA || !showB) return null;
      return { showA, showB, slug: `${slugA}-vs-${slugB}` };
    }).filter(Boolean) as ComparisonItem[];

  // Categorized comparisons for the hub display
  const categories = COMPARISON_CATEGORIES.map(cat => ({
    ...cat,
    comparisons: resolvePairs(cat.pairs),
  })).filter(cat => cat.comparisons.length > 0);

  // Collect all categorized slugs to find uncategorized ones
  const categorizedSlugs = new Set(
    COMPARISON_CATEGORIES.flatMap(cat => cat.pairs.map(([a, b]) => `${a}-vs-${b}`))
  );
  const uncategorized = resolvePairs(
    COMPARISON_PAIRS.filter(([a, b]) => !categorizedSlugs.has(`${a}-vs-${b}`))
  );

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Compare Shows' },
        ]} />

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3">
            Broadway Show Comparisons
          </h1>
          <p className="text-gray-400 text-base sm:text-lg max-w-2xl mx-auto">
            Can&apos;t decide between two shows? Compare CriticScore ratings, runtime, ticket prices,
            and lottery availability side by side to find the perfect show for you.
          </p>
        </div>

        {/* Categorized Comparisons */}
        {categories.map((category) => (
          <section key={category.label} className="mb-10">
            <h2 className="text-xl font-bold text-white mb-1">{category.label}</h2>
            <p className="text-gray-400 text-sm mb-4">{category.description}</p>
            <div className="grid gap-3">
              {category.comparisons.map(({ showA, showB, slug }) => (
                <ComparisonCard key={slug} showA={showA} showB={showB} slug={slug} />
              ))}
            </div>
          </section>
        ))}

        {/* Uncategorized (More Comparisons) */}
        {uncategorized.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-1">More Comparisons</h2>
            <p className="text-gray-400 text-sm mb-4">Even more head-to-head matchups</p>
            <div className="grid gap-3">
              {uncategorized.map(({ showA, showB, slug }) => (
                <ComparisonCard key={slug} showA={showA} showB={showB} slug={slug} />
              ))}
            </div>
          </section>
        )}

        {/* Bottom CTA */}
        <div className="mt-8 pt-6 border-t border-white/10 text-center">
          <p className="text-gray-400 text-sm mb-4">
            Looking for more options? Browse all Broadway shows by category.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/guides/best-broadway-shows" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Shows
            </Link>
            <Link href="/guides/best-broadway-musicals" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Best Musicals
            </Link>
            <Link href="/guides/cheap-broadway-tickets" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Cheap Tickets
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
