import Link from 'next/link';
import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceBuzzLastUpdated, getAudienceGrade, MIN_AUDIENCE_REVIEWS } from '@/lib/data-audience';
import type { AudienceBuzzData } from '@/lib/data-types';
import { generateBreadcrumbSchema, marketAlternates, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ComputedShow } from '@/lib/engine';
import { AudienceBuzzTable } from '@/components/SortableAudienceBuzzTable';
import { featureFlags } from '@/config/feature-flags';
import { getSourcesForMarket, getSourceNames, SOURCE_DESCRIPTIONS } from '@/config/audience-sources';

const bwSourceNames = getSourceNames('broadway');

export const metadata: Metadata = {
  title: 'Broadway Audience Scorecard - What Real Theatergoers Think',
  description: `AudienceGrade ratings for Broadway shows from ${bwSourceNames}. See which shows audiences love, like, or loathe based on real reviews.`,
  alternates: marketAlternates('broadway', '/audience-buzz'),
  openGraph: {
    title: 'Broadway Audience Scorecard - Real Broadway Audience Ratings',
    description: `What do audiences really think? Combined AudienceGrade ratings from ${bwSourceNames} for every Broadway show.`,
    url: `${BASE_URL}/audience-buzz`,
    type: 'article',
  },
};

// FAQ Schema for AI optimization
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is AudienceGrade?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: `AudienceGrade is our aggregated audience letter grade combining ratings from ${bwSourceNames}. It represents what real theatergoers think, separate from professional critic reviews.`,
      },
    },
    {
      '@type': 'Question',
      name: 'How is the AudienceGrade calculated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: `We combine ${getSourcesForMarket('broadway').length} sources — ${bwSourceNames} — weighted proportionally by their number of reviews. More reviews means more weight. No single source can account for more than 80% of the total. Reddit requires a minimum of 50 classified comments to be included.`,
      },
    },
    {
      '@type': 'Question',
      name: 'What do the AudienceGrade ratings mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Shows receive a letter grade from A+ (90-100, audiences love it) through F (below 48, audiences dislike it). The scale includes A/A- for strong reception, B+/B/B- for solid to mixed reception, and C+/C/C-/D for below-average to poor reception.',
      },
    },
  ],
};

const gradeScale = [
  { grade: 'A+', color: '#22c55e' },
  { grade: 'A', color: '#16a34a' },
  { grade: 'A-', color: '#14b8a6' },
  { grade: 'B+', color: '#0ea5e9' },
  { grade: 'B', color: '#f59e0b' },
  { grade: 'B-', color: '#f97316' },
  { grade: 'C+', color: '#ef4444' },
  { grade: 'C', color: '#dc2626' },
  { grade: 'C-', color: '#b91c1c' },
  { grade: 'D', color: '#991b1b' },
  { grade: 'F', color: '#6b7280' },
];

export default function AudienceBuzzPage() {
  const allShows = getBroadwayShows();
  const lastUpdated = getAudienceBuzzLastUpdated();
  const marketSources = getSourcesForMarket('broadway');

  // Get all shows with audience buzz data
  const showsWithBuzz = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      buzz: getAudienceBuzz(show.id),
    }))
    .filter(item => {
      if (!item.buzz || item.buzz.combinedScore <= 0) return false;
      const total = Object.values(item.buzz.sources || {}).reduce((sum, s) => sum + (s?.reviewCount || 0), 0);
      return total >= MIN_AUDIENCE_REVIEWS;
    })
    .sort((a, b) => (b.buzz?.combinedScore || 0) - (a.buzz?.combinedScore || 0));

  // Group by grade
  const byGrade = showsWithBuzz.reduce((acc, item) => {
    const grade = item.buzz ? getAudienceGrade(item.buzz.combinedScore).grade : 'Unknown';
    if (!acc[grade]) acc[grade] = [];
    acc[grade].push(item);
    return acc;
  }, {} as Record<string, typeof showsWithBuzz>);

  const totalReviews = showsWithBuzz.reduce((sum, item) => {
    if (!item.buzz) return sum;
    return sum + Object.values(item.buzz.sources || {}).reduce((s, src) => s + (src?.reviewCount || 0), 0);
  }, 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'AudienceGrade', url: `${BASE_URL}/audience-buzz` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Audience Scorecard</h1>
          <p className="text-gray-400 mt-2">
            What real theatergoers think. Combined AudienceGrade ratings from Show Score, Mezzanine, Theatr, Broadway.com, and Reddit.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithBuzz.length} shows · {totalReviews.toLocaleString()}+ audience reviews · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-gradient-to-r from-red-500/5 to-emerald-500/5 border-white/10">
          <h2 className="font-bold text-white mb-2">How AudienceGrade Works</h2>
          <p className="text-sm text-gray-400 mb-3">
            We combine {marketSources.length} audience sources into a single AudienceGrade letter grade. Each source is weighted proportionally by its number of reviews — more reviews means more influence. No single source can exceed 80% of the total weight.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 text-sm text-gray-400">
            {marketSources.map(src => (
              <div key={src.key}>
                <h3 className="font-semibold text-white mb-1">{src.name}</h3>
                <p>{SOURCE_DESCRIPTIONS[src.key] || 'Audience reviews and ratings.'}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Main Table */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">All Shows by AudienceGrade</h2>
          <p className="text-gray-400 text-sm mb-4">
            Click column headers to sort. Shows ranked by combined AudienceGrade rating.
          </p>
          <AudienceBuzzTable data={showsWithBuzz} sources={marketSources} />
        </section>

        {/* By Grade Breakdown */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">Shows by Grade</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {gradeScale.map(g => {
              const shows = byGrade[g.grade] || [];
              if (shows.length === 0) return null;
              return (
                <div key={g.grade} className="card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-sm font-black"
                      style={{ color: g.color, backgroundColor: `${g.color}20` }}
                    >
                      {g.grade}
                    </span>
                    <span className="text-gray-500 text-sm">{shows.length} show{shows.length !== 1 ? 's' : ''}</span>
                  </div>
                  <ul className="space-y-1">
                    {shows.slice(0, 8).map(item => (
                      <li key={item.show.slug} className="text-sm">
                        <Link href={`/show/${item.show.slug}`} className="text-gray-300 hover:text-white transition-colors truncate">
                          {item.show.title}
                        </Link>
                      </li>
                    ))}
                    {shows.length > 8 && (
                      <li className="text-gray-500 text-xs">+{shows.length - 8} more</li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-lg font-bold text-white mb-3">Related</h2>
          <div className="flex flex-wrap gap-3">
            {featureFlags.boxOffice && (
              <Link href="/box-office" className="text-brand hover:text-brand-hover transition-colors text-sm">
                Box Office Scorecard →
              </Link>
            )}
            {featureFlags.commercial && (
              <Link href="/biz-buzz" className="text-brand hover:text-brand-hover transition-colors text-sm">
                Commercial Scorecard →
              </Link>
            )}
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors text-sm">
              How Scoring Works →
            </Link>
          </div>
        </div>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Audience data aggregated from {marketSources.map(s => s.name).join(', ')}.
            Sources weighted proportionally by review count (80% cap per source). Updated weekly.
          </p>
        </div>
      </div>
    </>
  );
}
