import Link from 'next/link';

export const metadata = {
  title: 'Methodology - Broadway Metascore',
  description: 'How we calculate Broadway show scores from critic reviews, audience ratings, and community buzz.',
};

export default function MethodologyPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <Link href="/" className="text-green-400 hover:text-green-300 text-sm mb-4 inline-block">
          ← Back to shows
        </Link>
        <h1 className="text-4xl font-bold text-white">Methodology</h1>
        <p className="text-gray-400 mt-2">
          How we aggregate and calculate Broadway show scores.
        </p>
      </div>

      <div className="space-y-8">
        {/* Overview */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Overview</h2>
          <p className="text-gray-300 mb-4">
            Broadway Metascore aggregates three types of reception data to provide a comprehensive view of how a show is being received:
          </p>
          <ul className="space-y-2 text-gray-300">
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <div><strong>Critic Score (50% weight)</strong> — Aggregated professional reviews</div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <div><strong>Audience Score (35% weight)</strong> — Aggregated audience ratings from platforms</div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <div><strong>Buzz Score (15% weight)</strong> — Community discussion volume and sentiment</div>
            </li>
          </ul>
        </section>

        {/* Rating Normalization */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Rating Normalization</h2>
          <p className="text-gray-300 mb-4">
            All ratings are normalized to a 0–100 scale for comparability.
          </p>

          <h3 className="text-lg font-semibold text-white mt-6 mb-3">Star Ratings</h3>
          <p className="text-gray-300 mb-2">Converted using: <code className="bg-gray-700 px-2 py-1 rounded">(stars / max_stars) × 100</code></p>
          <div className="bg-gray-700/50 rounded-lg p-4 mt-2">
            <table className="w-full text-sm">
              <thead className="text-gray-400">
                <tr>
                  <th className="text-left pb-2">Rating</th>
                  <th className="text-left pb-2">Mapped Score</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr><td>5/5 stars</td><td>100</td></tr>
                <tr><td>4/5 stars</td><td>80</td></tr>
                <tr><td>3/5 stars</td><td>60</td></tr>
                <tr><td>3.5/5 stars</td><td>70</td></tr>
              </tbody>
            </table>
          </div>

          <h3 className="text-lg font-semibold text-white mt-6 mb-3">Letter Grades</h3>
          <div className="bg-gray-700/50 rounded-lg p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-400 mb-2">A Range</div>
                <div className="text-gray-300">A+ = 98</div>
                <div className="text-gray-300">A = 95</div>
                <div className="text-gray-300">A- = 92</div>
              </div>
              <div>
                <div className="text-gray-400 mb-2">B Range</div>
                <div className="text-gray-300">B+ = 88</div>
                <div className="text-gray-300">B = 85</div>
                <div className="text-gray-300">B- = 82</div>
              </div>
              <div>
                <div className="text-gray-400 mb-2">C Range</div>
                <div className="text-gray-300">C+ = 78</div>
                <div className="text-gray-300">C = 75</div>
                <div className="text-gray-300">C- = 72</div>
              </div>
              <div>
                <div className="text-gray-400 mb-2">D/F Range</div>
                <div className="text-gray-300">D+ = 68</div>
                <div className="text-gray-300">D = 65</div>
                <div className="text-gray-300">F = 50</div>
              </div>
            </div>
          </div>

          <h3 className="text-lg font-semibold text-white mt-6 mb-3">Sentiment-Based Ratings</h3>
          <p className="text-gray-300 mb-2">
            When a review has no explicit rating, we infer from sentiment keywords. These are marked as &ldquo;inferred&rdquo; and receive reduced weight.
          </p>
          <div className="bg-gray-700/50 rounded-lg p-4">
            <table className="w-full text-sm">
              <thead className="text-gray-400">
                <tr>
                  <th className="text-left pb-2">Sentiment</th>
                  <th className="text-left pb-2">Mapped Score</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr><td>Rave</td><td>95</td></tr>
                <tr><td>Positive</td><td>80</td></tr>
                <tr><td>Mixed-Positive</td><td>65</td></tr>
                <tr><td>Mixed</td><td>55</td></tr>
                <tr><td>Mixed-Negative</td><td>45</td></tr>
                <tr><td>Negative</td><td>30</td></tr>
                <tr><td>Pan</td><td>15</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Critic Score */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Critic Score Calculation</h2>
          <p className="text-gray-300 mb-4">
            Critic scores are weighted averages based on outlet tier and rating type.
          </p>

          <h3 className="text-lg font-semibold text-white mt-6 mb-3">Outlet Tiers</h3>
          <div className="space-y-4">
            <div className="bg-gray-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-sm">Tier 1 (1.5× weight)</span>
              </div>
              <p className="text-gray-300 text-sm">
                Major national publications: The New York Times, Vulture, Variety, The Hollywood Reporter, Time Out New York, The Washington Post
              </p>
            </div>

            <div className="bg-gray-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-sm">Tier 2 (1.0× weight)</span>
              </div>
              <p className="text-gray-300 text-sm">
                Major theater outlets: TheaterMania, Broadway News, BroadwayWorld, New York Magazine, Entertainment Weekly, The Guardian, Associated Press
              </p>
            </div>

            <div className="bg-gray-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded bg-gray-500/20 text-gray-400 text-sm">Tier 3 (0.5× weight)</span>
              </div>
              <p className="text-gray-300 text-sm">
                Smaller outlets and blogs. Generally excluded in MVP.
              </p>
            </div>
          </div>

          <h3 className="text-lg font-semibold text-white mt-6 mb-3">Inferred Score Penalty</h3>
          <p className="text-gray-300">
            Scores inferred from sentiment (rather than explicit ratings) receive 50% of their tier weight.
          </p>
        </section>

        {/* Audience Score */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Audience Score Calculation</h2>
          <p className="text-gray-300 mb-4">
            Audience scores aggregate ratings from multiple platforms with the following default weights:
          </p>

          <div className="bg-gray-700/50 rounded-lg p-4">
            <table className="w-full text-sm">
              <thead className="text-gray-400">
                <tr>
                  <th className="text-left pb-2">Platform</th>
                  <th className="text-left pb-2">Weight</th>
                  <th className="text-left pb-2">Notes</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                <tr>
                  <td>Show-Score</td>
                  <td>50%</td>
                  <td>Theater-focused platform</td>
                </tr>
                <tr>
                  <td>Google Reviews</td>
                  <td>30%</td>
                  <td>General audience</td>
                </tr>
                <tr>
                  <td>Mezzanine / Other</td>
                  <td>20%</td>
                  <td>When available with adequate sample size</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
            <p className="text-yellow-300 text-sm">
              <strong>Divergence Warning:</strong> When platforms differ by more than 20 points, we display a warning and show individual platform scores for transparency.
            </p>
          </div>
        </section>

        {/* Buzz Score */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Buzz Score Calculation</h2>
          <p className="text-gray-300 mb-4">
            Buzz measures community discussion activity and sentiment, primarily from Reddit (r/Broadway, r/musicals).
          </p>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-gray-700/50 rounded-lg p-4">
              <h3 className="font-semibold text-white mb-2">Volume Score (0–50)</h3>
              <ul className="text-sm text-gray-300 space-y-1">
                <li>• Number of threads in last 14–30 days</li>
                <li>• Total engagement (upvotes + comments)</li>
                <li>• Compared against baseline activity</li>
              </ul>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-4">
              <h3 className="font-semibold text-white mb-2">Sentiment Score (0–50)</h3>
              <ul className="text-sm text-gray-300 space-y-1">
                <li>• Per-thread sentiment analysis</li>
                <li>• Weighted by engagement (log scale)</li>
                <li>• Positive = 50, Mixed = 25, Negative = 0</li>
              </ul>
            </div>
          </div>

          <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
            <p className="text-yellow-300 text-sm">
              <strong>Staleness Penalty:</strong> If more than half of tracked threads are older than 30 days, a 10-point penalty is applied to the buzz score.
            </p>
          </div>
        </section>

        {/* Overall Metascore */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Overall Metascore</h2>
          <p className="text-gray-300 mb-4">
            The overall metascore combines all three components:
          </p>

          <div className="bg-gray-700/50 rounded-lg p-4 font-mono text-center text-lg">
            <span className="text-green-400">Overall</span> =
            (<span className="text-blue-400">Critic × 50%</span>) +
            (<span className="text-purple-400">Audience × 35%</span>) +
            (<span className="text-yellow-400">Buzz × 15%</span>)
          </div>

          <p className="text-gray-400 mt-4 text-sm">
            If any component is missing, weights are redistributed among available components proportionally.
          </p>
        </section>

        {/* Confidence */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Confidence Rating</h2>
          <p className="text-gray-300 mb-4">
            Each score includes a confidence indicator based on data quality:
          </p>

          <div className="space-y-4">
            <div className="flex items-start gap-4 p-4 rounded-lg bg-green-500/10 border border-green-500/30">
              <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-sm font-medium">High</span>
              <div className="text-gray-300 text-sm">
                10+ critic reviews across multiple top-tier outlets, stable audience data from multiple platforms
              </div>
            </div>

            <div className="flex items-start gap-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-sm font-medium">Medium</span>
              <div className="text-gray-300 text-sm">
                5–9 critic reviews, or limited/mixed audience data, or recent opening
              </div>
            </div>

            <div className="flex items-start gap-4 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
              <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-sm font-medium">Low</span>
              <div className="text-gray-300 text-sm">
                Fewer than 5 critic reviews, show in previews, high disagreement between sources, or mostly inferred scores
              </div>
            </div>
          </div>
        </section>

        {/* Score Interpretation */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Score Interpretation</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-10 rounded bg-green-500 flex items-center justify-center font-bold text-white">70+</div>
              <p className="text-gray-300">Generally favorable reception</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-16 h-10 rounded bg-yellow-500 flex items-center justify-center font-bold text-gray-900">50-69</div>
              <p className="text-gray-300">Mixed reception</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-16 h-10 rounded bg-red-500 flex items-center justify-center font-bold text-white">&lt;50</div>
              <p className="text-gray-300">Generally unfavorable reception</p>
            </div>
          </div>
        </section>

        {/* Data Sources */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Data Sources</h2>

          <h3 className="text-lg font-semibold text-white mt-4 mb-2">Critics</h3>
          <p className="text-gray-300 text-sm mb-4">
            We prioritize: The New York Times, Vulture, Variety, The Hollywood Reporter, Time Out, The Washington Post, TheaterMania, Broadway News, BroadwayWorld, and other established outlets.
          </p>

          <h3 className="text-lg font-semibold text-white mt-4 mb-2">Audience</h3>
          <p className="text-gray-300 text-sm mb-4">
            Primary: Show-Score, Google Reviews. Secondary: Mezzanine (when available).
          </p>

          <h3 className="text-lg font-semibold text-white mt-4 mb-2">Buzz</h3>
          <p className="text-gray-300 text-sm">
            Reddit communities: r/Broadway, r/musicals, and show-specific discussions. Weighted by engagement and recency.
          </p>
        </section>

        {/* Updates */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Updates & Freshness</h2>
          <ul className="text-gray-300 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Scores are updated regularly, typically within 24-48 hours of new major reviews</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Each show page displays a &ldquo;last updated&rdquo; timestamp</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Buzz scores are refreshed weekly to capture recent discussion</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>New shows may have lower confidence until sufficient reviews accumulate</span>
            </li>
          </ul>
        </section>

        {/* Transparency */}
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Transparency</h2>
          <p className="text-gray-300 mb-4">
            We believe in complete transparency about how scores are calculated:
          </p>
          <ul className="text-gray-300 space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Every individual review is listed with its source, original rating, and mapped score</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Inferred scores are clearly marked</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Platform-specific audience scores are shown alongside the aggregate</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Buzz sources link directly to original discussions</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Raw data is available on the <Link href="/data" className="text-green-400 hover:underline">Data page</Link></span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
