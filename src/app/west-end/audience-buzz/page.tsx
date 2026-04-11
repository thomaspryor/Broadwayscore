import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import { getAudienceBuzz, getAudienceBuzzLastUpdated, getAudienceGrade } from '@/lib/data-audience';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { AudienceBuzzTable } from '@/components/SortableAudienceBuzzTable';
import { featureFlags } from '@/config/feature-flags';
import { getSourcesForMarket, getSourceNames, SOURCE_DESCRIPTIONS } from '@/config/audience-sources';

const weSourceNames = getSourceNames('west-end');

export const metadata: Metadata = {
  title: {
    absolute: 'West End Audience Scorecard - What Real Theatregoers Think | West End Scorecard',
  },
  description: `AudienceGrade ratings for West End shows from ${weSourceNames}. See which shows audiences love based on verified reviews.`,
  alternates: {
    canonical: `${BASE_URL}/west-end/audience-buzz`,
  },
  openGraph: {
    title: 'West End Audience Scorecard - Real Audience Ratings',
    description: 'What do audiences really think? Combined AudienceGrade ratings from verified review platforms for every West End show.',
    url: `${BASE_URL}/west-end/audience-buzz`,
    type: 'article',
  },
};

// West End audience-buzz needs a higher threshold than Broadway to avoid Garry-Starr-ranks-#1
// embarrassment. Marquee WE shows have thousands of reviews; small fringe shows with 15-20
// reviews shouldn't outrank Hamilton.
const MIN_WE_AUDIENCE_REVIEWS = 50;

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

export default function WestEndAudienceBuzzPage() {
  // West End only — exclude Off-West End
  const allShows = getAllShows().filter(s => s.category === 'west-end');
  const lastUpdated = getAudienceBuzzLastUpdated();
  const marketSources = getSourcesForMarket('west-end');

  const showsWithBuzz = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      buzz: getAudienceBuzz(show.id),
    }))
    .filter(item => {
      if (!item.buzz || item.buzz.combinedScore <= 0) return false;
      const total = Object.values(item.buzz.sources || {}).reduce((sum, s) => sum + (s?.reviewCount || 0), 0);
      return total >= MIN_WE_AUDIENCE_REVIEWS;
    })
    .sort((a, b) => (b.buzz?.combinedScore || 0) - (a.buzz?.combinedScore || 0));

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
    { name: 'West End', url: `${BASE_URL}/west-end` },
    { name: 'AudienceGrade', url: `${BASE_URL}/west-end/audience-buzz` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/west-end" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          West End Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">West End Audience Scorecard</h1>
          <p className="text-gray-400 mt-2">
            What real theatregoers think. Combined AudienceGrade ratings from {marketSources.map(s => s.name).join(', ')}.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithBuzz.length} shows · {totalReviews.toLocaleString()}+ audience reviews · Updated {new Date(lastUpdated).toLocaleDateString('en-GB', { month: 'long', day: 'numeric', year: 'numeric' })}
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
            <Link href="/west-end" className="text-brand hover:text-brand-hover transition-colors text-sm">
              All West End Shows →
            </Link>
            <Link href="/audience-buzz" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Broadway Audience Scorecard →
            </Link>
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
