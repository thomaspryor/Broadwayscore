import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getAudienceBuzz, getAudienceBuzzLastUpdated, AudienceBuzzData, getAudienceGrade } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { ComputedShow } from '@/lib/engine';
import { AudienceBuzzTable } from '@/components/SortableAudienceBuzzTable';

export const metadata: Metadata = {
  title: 'Audience Scorecard - What Real Theatergoers Think',
  description: 'Audience scores for Broadway shows from Show Score, Mezzanine, and Reddit. See which shows audiences love, like, or loathe based on real reviews.',
  alternates: {
    canonical: `${BASE_URL}/audience-buzz`,
  },
  openGraph: {
    title: 'Audience Scorecard - Real Broadway Audience Ratings',
    description: 'What do audiences really think? Combined scores from Show Score, Mezzanine, and Reddit for every Broadway show.',
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
      name: 'What is Broadway Audience Scorecard?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Audience Scorecard is our aggregated audience score combining ratings from Show Score, Mezzanine, and Reddit r/Broadway discussions. It represents what real theatergoers think, separate from professional critic reviews.',
      },
    },
    {
      '@type': 'Question',
      name: 'How is the Audience Scorecard score calculated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'We combine three sources: Show Score and Mezzanine split 80% of the weight proportionally by sample size (more reviews = more weight), while Reddit sentiment analysis contributes a fixed 20%. This balances broad audience feedback with passionate community discussion.',
      },
    },
    {
      '@type': 'Question',
      name: 'What do the Audience Scorecard grades mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Shows receive a letter grade from A+ (93-100, audiences love it) through F (below 48, audiences dislike it). The scale includes A/A- for strong reception, B+/B/B- for solid to mixed reception, and C+/C/C-/D for below-average to poor reception.',
      },
    },
  ],
};

const gradeScale = [
  { grade: 'A+', range: '93-100', color: '#22c55e' },
  { grade: 'A', range: '88-92', color: '#16a34a' },
  { grade: 'A-', range: '83-87', color: '#14b8a6' },
  { grade: 'B+', range: '78-82', color: '#0ea5e9' },
  { grade: 'B', range: '73-77', color: '#f59e0b' },
  { grade: 'B-', range: '68-72', color: '#f97316' },
  { grade: 'C+', range: '63-67', color: '#ef4444' },
  { grade: 'C', range: '58-62', color: '#dc2626' },
  { grade: 'C-', range: '53-57', color: '#b91c1c' },
  { grade: 'D', range: '48-52', color: '#991b1b' },
  { grade: 'F', range: '<48', color: '#6b7280' },
];

export default function AudienceBuzzPage() {
  const allShows = getAllShows();
  const lastUpdated = getAudienceBuzzLastUpdated();

  // Get all shows with audience buzz data
  const showsWithBuzz = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      buzz: getAudienceBuzz(show.id),
    }))
    .filter(item => item.buzz && item.buzz.combinedScore > 0)
    .sort((a, b) => (b.buzz?.combinedScore || 0) - (a.buzz?.combinedScore || 0));

  // Group by grade
  const byGrade = showsWithBuzz.reduce((acc, item) => {
    const grade = item.buzz ? getAudienceGrade(item.buzz.combinedScore).grade : 'Unknown';
    if (!acc[grade]) acc[grade] = [];
    acc[grade].push(item);
    return acc;
  }, {} as Record<string, typeof showsWithBuzz>);

  // Stats
  const avgScore = Math.round(
    showsWithBuzz.reduce((sum, item) => sum + (item.buzz?.combinedScore || 0), 0) / showsWithBuzz.length
  );
  const totalReviews = showsWithBuzz.reduce((sum, item) => {
    const buzz = item.buzz;
    if (!buzz) return sum;
    return sum +
      (buzz.sources.showScore?.reviewCount || 0) +
      (buzz.sources.mezzanine?.reviewCount || 0) +
      (buzz.sources.reddit?.reviewCount || 0);
  }, 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Audience Scorecard', url: `${BASE_URL}/audience-buzz` },
  ]);

  const aGradeCount = (byGrade['A+']?.length || 0) + (byGrade['A']?.length || 0) + (byGrade['A-']?.length || 0);

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
            What real theatergoers think. Combined audience scores from Show Score, Mezzanine, and Reddit.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithBuzz.length} shows · {totalReviews.toLocaleString()}+ audience reviews · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Grade Scale Legend */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">Audience Grade Scale</h2>
          <div className="flex flex-wrap gap-2">
            {gradeScale.map(g => (
              <div
                key={g.grade}
                className="card px-3 py-2 border-transparent flex items-center gap-2"
                style={{ backgroundColor: `${g.color}15` }}
              >
                <span className="text-sm font-bold" style={{ color: g.color }}>{g.grade}</span>
                <span className="text-xs text-gray-500">{g.range}</span>
                {byGrade[g.grade] && (
                  <span className="text-xs text-gray-600">({byGrade[g.grade].length})</span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{avgScore}</div>
            <div className="text-xs text-gray-500 mt-1">Average Score</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{aGradeCount}</div>
            <div className="text-xs text-gray-500 mt-1">A-Range Shows</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-gray-400">{totalReviews.toLocaleString()}</div>
            <div className="text-xs text-gray-500 mt-1">Total Reviews</div>
          </div>
        </div>

        {/* How It Works */}
        <div className="card p-5 mb-8 bg-gradient-to-r from-red-500/5 to-emerald-500/5 border-white/10">
          <h2 className="font-bold text-white mb-2">How Audience Scorecard Works</h2>
          <div className="grid sm:grid-cols-3 gap-4 text-sm text-gray-400">
            <div>
              <h3 className="font-semibold text-white mb-1">Show Score (40%)</h3>
              <p>Aggregates audience reviews with detailed 0-100 scores. Large sample sizes.</p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">Mezzanine (40%)</h3>
              <p>iOS app with verified ticket holders rating shows 1-5 stars, converted to 0-100.</p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">Reddit (20%)</h3>
              <p>Sentiment analysis from r/Broadway discussions. Captures passionate fan opinions.</p>
            </div>
          </div>
        </div>

        {/* Main Table */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">All Shows by Audience Score</h2>
          <p className="text-gray-400 text-sm mb-4">
            Click column headers to sort. Shows ranked by combined audience score.
          </p>
          <AudienceBuzzTable data={showsWithBuzz} />
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
                    <span className="text-gray-500 text-sm">{g.range} · {shows.length} shows</span>
                  </div>
                  <ul className="space-y-1">
                    {shows.slice(0, 8).map(item => (
                      <li key={item.show.slug} className="text-sm flex justify-between">
                        <Link href={`/show/${item.show.slug}`} className="text-gray-300 hover:text-white transition-colors truncate">
                          {item.show.title}
                        </Link>
                        <span className="text-gray-500 ml-2 flex-shrink-0">{item.buzz?.combinedScore}</span>
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
            <Link href="/box-office" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Box Office Scorecard →
            </Link>
            <Link href="/biz-buzz" className="text-brand hover:text-brand-hover transition-colors text-sm">
              Commercial Scorecard →
            </Link>
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors text-sm">
              How Scoring Works →
            </Link>
          </div>
        </div>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-6">
          <p>
            Audience data aggregated from Show Score, Mezzanine app, and Reddit r/Broadway.
            Scores are weighted by sample size and recency. Updated weekly.
          </p>
        </div>
      </div>
    </>
  );
}
