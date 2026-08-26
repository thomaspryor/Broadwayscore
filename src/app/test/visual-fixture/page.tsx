import ReviewsList from '@/components/ReviewsList';

/**
 * Visual regression test fixture page.
 * Renders real components with hardcoded mock data so screenshots are stable
 * regardless of live data changes. Only used by Playwright visual tests.
 */

const MOCK_REVIEWS = [
  {
    showId: 'test-show',
    outletId: 'nyt',
    outlet: 'The New York Times',
    criticName: 'Jesse Green',
    url: 'https://example.com/review-1',
    publishDate: '2024-04-25',
    tier: 1 as const,
    reviewScore: 92,
    designation: 'Critics_Pick',
    quote: 'A stunning achievement that redefines what musical theater can be on a Broadway stage.',
  },
  {
    showId: 'test-show',
    outletId: 'variety',
    outlet: 'Variety',
    criticName: 'Frank Rizzo',
    url: 'https://example.com/review-2',
    publishDate: '2024-04-24',
    tier: 1 as const,
    reviewScore: 78,
    quote: 'Strong performances carry this ambitious but uneven production through its rougher patches.',
  },
  {
    showId: 'test-show',
    outletId: 'ny-post',
    outlet: 'New York Post',
    criticName: 'Johnny Oleksinski',
    url: 'https://example.com/review-3',
    publishDate: '2024-04-23',
    tier: 2 as const,
    reviewScore: 45,
    summary: 'Despite a talented cast, the show fails to find its footing in a crowded season.',
  },
];

export default function VisualFixturePage() {
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

        {/* Show Header Card — mirrors src/app/show/[slug]/page.tsx structure */}
        <div className="card p-5 sm:p-6" data-testid="show-header-card">
          <div className="flex gap-4 sm:gap-6">
            {/* Poster placeholder */}
            <div className="flex-shrink-0 w-28 sm:w-36 lg:w-40">
              <div className="aspect-[2/3] rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-surface-raised">
                <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                  <span className="text-4xl text-gray-500">🎭</span>
                </div>
              </div>
            </div>

            {/* Right side: Title, Meta, Score */}
            <div className="flex-1 min-w-0">
              {/* Pills row */}
              <div className="flex flex-wrap items-center gap-1.5 mb-2" data-testid="show-pills-row">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">Musical</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">New Production</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-500/20 text-green-300 border border-green-500/30">Open</span>
              </div>

              {/* Title */}
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight mb-2">
                Test Show: A Visual Fixture
              </h1>

              {/* Meta line — inline text wrapping (the bug this catches) */}
              <p className="text-gray-400 text-xs sm:text-sm mb-4 leading-relaxed" data-testid="show-meta-line">
                <span className="text-gray-300">Golden Theatre</span>
                <span className="whitespace-nowrap"> <span className="text-gray-500">&middot;</span> 2h 45m (incl. intermission)</span>
                <span> <span className="text-gray-500">&middot;</span> <span className="text-amber-400">Closes Dec 15, 2024</span></span>
                <span> <span className="text-gray-500">&middot;</span> Opened Apr 25, 2024</span>
              </p>

              {/* Score section */}
              <div className="space-y-3" data-testid="show-score-section">
                <div className="flex items-center gap-3 sm:gap-4">
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg flex items-center justify-center flex-shrink-0 score-great">
                    <span className="text-3xl font-extrabold">78</span>
                  </div>
                  <div>
                    <div className="text-base sm:text-lg font-bold text-score-high">Recommended</div>
                    <span className="text-sm text-gray-400">Based on 12 critic reviews</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Review Cards — uses real ReviewsList component */}
        <div>
          <h2 className="text-lg font-bold text-white mb-4">Critic Reviews</h2>
          <ReviewsList reviews={MOCK_REVIEWS} initialCount={10} />
        </div>

      </div>
    </div>
  );
}
