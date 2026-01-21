import Link from 'next/link';

export const metadata = {
  title: 'How It Works - BroadwayMetaScores',
  description: 'How we calculate Broadway show scores from critic reviews, audience ratings, and community buzz.',
};

export default function MethodologyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <Link href="/" className="text-brand hover:text-brand-hover text-sm mb-4 inline-flex items-center gap-1 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to shows
        </Link>
        <h1 className="text-3xl sm:text-4xl font-bold text-white mt-4">How It Works</h1>
        <p className="text-gray-400 mt-2">
          Our methodology for aggregating and calculating Broadway show scores.
        </p>
      </div>

      <div className="space-y-6">
        {/* Overview */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Overview</h2>
          <p className="text-gray-300 mb-4">
            BroadwayMetaScores aggregates three types of reception data to provide a comprehensive view of how a show is being received:
          </p>
          <ul className="space-y-3 text-gray-300">
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand/20 text-brand text-xs font-bold flex-shrink-0">50</span>
              <div><strong className="text-white">Critic Score</strong> — Aggregated professional reviews weighted by outlet tier</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 text-xs font-bold flex-shrink-0">35</span>
              <div><strong className="text-white">Audience Score</strong> — Aggregated audience ratings from platforms like Show-Score</div>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold flex-shrink-0">15</span>
              <div><strong className="text-white">Buzz Score</strong> — Community discussion volume and sentiment from Reddit</div>
            </li>
          </ul>
        </section>

        {/* Score Labels */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Score Interpretation</h2>
          <p className="text-gray-300 mb-4">
            Scores are labeled based on these thresholds:
          </p>
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-high flex items-center justify-center font-bold text-white text-sm">85+</div>
              <div>
                <span className="text-white font-medium">Must See!</span>
                <span className="text-gray-500 ml-2">— Universal acclaim</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-high flex items-center justify-center font-bold text-white text-sm">75-84</div>
              <div>
                <span className="text-white font-medium">Excellent</span>
                <span className="text-gray-500 ml-2">— Strong praise</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-high flex items-center justify-center font-bold text-white text-sm">65-74</div>
              <div>
                <span className="text-white font-medium">Great</span>
                <span className="text-gray-500 ml-2">— Generally favorable</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-medium flex items-center justify-center font-bold text-gray-900 text-sm">55-64</div>
              <div>
                <span className="text-white font-medium">Good</span>
                <span className="text-gray-500 ml-2">— More positive than negative</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-medium flex items-center justify-center font-bold text-gray-900 text-sm">45-54</div>
              <div>
                <span className="text-white font-medium">Mixed</span>
                <span className="text-gray-500 ml-2">— Divided reception</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-10 rounded-lg bg-score-low flex items-center justify-center font-bold text-white text-sm">&lt;45</div>
              <div>
                <span className="text-white font-medium">Poor</span>
                <span className="text-gray-500 ml-2">— Generally unfavorable</span>
              </div>
            </div>
          </div>
        </section>

        {/* Critic Score */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Critic Score Calculation</h2>
          <p className="text-gray-300 mb-4">
            Critic scores are weighted averages based on outlet tier. Each review is assigned a score from 0-100 based on its rating or sentiment.
          </p>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Outlet Tiers</h3>
          <div className="space-y-3">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-accent-gold/20 text-accent-gold text-xs font-medium">Tier 1</span>
                <span className="text-gray-400 text-sm">Weight: 1.0×</span>
              </div>
              <p className="text-gray-300 text-sm">
                The New York Times, Washington Post, Variety, Hollywood Reporter, Vulture, The Guardian, Time Out, Broadway News, LA Times, Wall Street Journal, AP
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-gray-500/20 text-gray-400 text-xs font-medium">Tier 2</span>
                <span className="text-gray-400 text-sm">Weight: 0.85×</span>
              </div>
              <p className="text-gray-300 text-sm">
                NY Post, NY Daily News, TheaterMania, Entertainment Weekly, Deadline, The Wrap, IndieWire, Observer, Slant, Chicago Tribune, USA Today, NY Stage Review, NY Theatre Guide
              </p>
            </div>

            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-surface text-gray-500 text-xs font-medium">Tier 3</span>
                <span className="text-gray-400 text-sm">Weight: 0.70×</span>
              </div>
              <p className="text-gray-300 text-sm">
                BroadwayWorld, amNewYork, Front Mezz Junkies, Culture Sauce, and other smaller outlets/blogs
              </p>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Designation Bumps</h3>
          <p className="text-gray-300 text-sm mb-3">
            Special designations add bonus points to a review&apos;s base score:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">NYT Critics&apos; Pick</div>
              <div className="text-brand">+3 points</div>
              <div className="text-gray-400">Time Out Critics&apos; Choice</div>
              <div className="text-brand">+2 points</div>
              <div className="text-gray-400">Recommended / Pick</div>
              <div className="text-brand">+2 points</div>
            </div>
          </div>
        </section>

        {/* Rating Normalization */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Rating Normalization</h2>
          <p className="text-gray-300 mb-4">
            All ratings are normalized to a 0–100 scale for comparability.
          </p>

          <h3 className="text-base font-semibold text-white mt-4 mb-3">Star Ratings</h3>
          <p className="text-gray-300 text-sm mb-2">
            Converted using: <code className="bg-surface-overlay px-2 py-1 rounded text-brand">(stars / max_stars) × 100</code>
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5 mt-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">5/5 stars</div><div className="text-gray-300">100</div>
              <div className="text-gray-400">4/5 stars</div><div className="text-gray-300">80</div>
              <div className="text-gray-400">3.5/5 stars</div><div className="text-gray-300">70</div>
              <div className="text-gray-400">3/5 stars</div><div className="text-gray-300">60</div>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Letter Grades</h3>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500 mb-1">A Range</div>
                <div className="text-gray-300">A+ = 100</div>
                <div className="text-gray-300">A = 95</div>
                <div className="text-gray-300">A- = 90</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">B Range</div>
                <div className="text-gray-300">B+ = 85</div>
                <div className="text-gray-300">B = 80</div>
                <div className="text-gray-300">B- = 75</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">C Range</div>
                <div className="text-gray-300">C+ = 70</div>
                <div className="text-gray-300">C = 65</div>
                <div className="text-gray-300">C- = 60</div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">D/F Range</div>
                <div className="text-gray-300">D+ = 55</div>
                <div className="text-gray-300">D = 50</div>
                <div className="text-gray-300">F = 30</div>
              </div>
            </div>
          </div>

          <h3 className="text-base font-semibold text-white mt-6 mb-3">Sentiment Buckets</h3>
          <p className="text-gray-300 text-sm mb-3">
            When a review has no explicit rating, we categorize based on sentiment:
          </p>
          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-400">Rave</div><div className="text-score-high">90</div>
              <div className="text-gray-400">Positive</div><div className="text-score-high">82</div>
              <div className="text-gray-400">Mixed-Positive</div><div className="text-score-high">72</div>
              <div className="text-gray-400">Mixed / Neutral</div><div className="text-score-medium">65</div>
              <div className="text-gray-400">Mixed-Negative</div><div className="text-score-medium">58</div>
              <div className="text-gray-400">Negative</div><div className="text-score-low">48</div>
              <div className="text-gray-400">Pan</div><div className="text-score-low">30</div>
            </div>
          </div>
        </section>

        {/* Audience Score */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Audience Score</h2>
          <p className="text-gray-300 mb-4">
            Audience scores aggregate ratings from multiple platforms:
          </p>

          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-gray-300">Show-Score</span>
                <span className="text-brand font-medium">50% weight</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-300">Google Reviews</span>
                <span className="text-brand font-medium">30% weight</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-300">Mezzanine / Other</span>
                <span className="text-brand font-medium">20% weight</span>
              </div>
            </div>
          </div>

          <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <p className="text-yellow-300 text-sm">
              <strong>Note:</strong> When platforms differ by more than 20 points, we display individual platform scores for transparency.
            </p>
          </div>
        </section>

        {/* Buzz Score */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Buzz Score</h2>
          <p className="text-gray-300 mb-4">
            Buzz measures community discussion activity and sentiment, primarily from Reddit (r/Broadway, r/musicals).
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <h3 className="font-semibold text-white mb-2">Volume (0–50 pts)</h3>
              <ul className="text-sm text-gray-300 space-y-1">
                <li>• Thread count in last 14–30 days</li>
                <li>• Total engagement (upvotes + comments)</li>
                <li>• Compared against baseline activity</li>
              </ul>
            </div>
            <div className="bg-surface-overlay rounded-lg p-4 border border-white/5">
              <h3 className="font-semibold text-white mb-2">Sentiment (0–50 pts)</h3>
              <ul className="text-sm text-gray-300 space-y-1">
                <li>• Per-thread sentiment analysis</li>
                <li>• Weighted by engagement</li>
                <li>• Positive=50, Mixed=25, Negative=0</li>
              </ul>
            </div>
          </div>

          <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <p className="text-yellow-300 text-sm">
              <strong>Staleness Penalty:</strong> If more than half of tracked threads are older than 30 days, a 10-point penalty is applied.
            </p>
          </div>
        </section>

        {/* Overall Formula */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Overall Score Formula</h2>
          <p className="text-gray-300 mb-4">
            The overall score combines all three components:
          </p>

          <div className="bg-surface-overlay rounded-lg p-4 border border-white/5 text-center">
            <code className="text-sm sm:text-base">
              <span className="text-white">Overall</span>
              <span className="text-gray-500"> = </span>
              <span className="text-brand">(Critic × 0.50)</span>
              <span className="text-gray-500"> + </span>
              <span className="text-purple-400">(Audience × 0.35)</span>
              <span className="text-gray-500"> + </span>
              <span className="text-yellow-400">(Buzz × 0.15)</span>
            </code>
          </div>

          <p className="text-gray-500 mt-4 text-sm">
            If any component is missing, weights are redistributed among available components proportionally.
          </p>
        </section>

        {/* Confidence */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Confidence Rating</h2>
          <p className="text-gray-300 mb-4">
            Each score includes a confidence indicator based on data quality:
          </p>

          <div className="space-y-3">
            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-high/10 border border-score-high/20">
              <span className="px-2 py-0.5 rounded bg-score-high/20 text-score-high text-xs font-medium flex-shrink-0">High</span>
              <div className="text-gray-300 text-sm">
                15+ critic reviews with 3+ from Tier 1 outlets, audience data from 2+ platforms
              </div>
            </div>

            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-medium/10 border border-score-medium/20">
              <span className="px-2 py-0.5 rounded bg-score-medium/20 text-score-medium text-xs font-medium flex-shrink-0">Medium</span>
              <div className="text-gray-300 text-sm">
                6–14 critic reviews with at least 1 Tier 1 outlet, audience data from 1+ platform
              </div>
            </div>

            <div className="flex items-start gap-4 p-3 rounded-lg bg-score-low/10 border border-score-low/20">
              <span className="px-2 py-0.5 rounded bg-score-low/20 text-score-low text-xs font-medium flex-shrink-0">Low</span>
              <div className="text-gray-300 text-sm">
                Fewer than 6 critic reviews, show in previews, or limited data sources
              </div>
            </div>
          </div>
        </section>

        {/* Transparency */}
        <section className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold text-white mb-4">Transparency</h2>
          <p className="text-gray-300 mb-4">
            We believe in complete transparency:
          </p>
          <ul className="text-gray-300 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Every individual review is listed with its source, original rating, and mapped score</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Outlet tiers and weights are clearly documented above</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Platform-specific audience scores are shown alongside the aggregate</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>All scoring rules are defined in our open-source codebase</span>
            </li>
          </ul>
        </section>

        {/* Version */}
        <div className="text-center text-gray-500 text-sm pt-4">
          <p>Methodology Version 2.0.0 — Last updated January 2026</p>
        </div>
      </div>
    </div>
  );
}
