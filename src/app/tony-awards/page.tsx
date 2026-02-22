import Link from 'next/link';
import type { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getScoreTier } from '@/components/show-cards/ScoreBadge';
import { featureFlags } from '@/config/feature-flags';
import { getTonyLeaderboard, getTonyNominationsMeta } from '@/lib/data-tony-noms';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
  getHistoricalWinners,
} from '@/lib/data-tony-predictions';

// --- SEO ---

const season = getTonySeasonWindow();

export const metadata: Metadata = {
  title: 'Tony Awards — Predictions, Leaderboard & Historical Data',
  description: `Data-driven Tony Awards analysis: ${season.ceremonyYear} predictions ranked by critic scores, the all-time leaderboard of winners and nominees, and 12 seasons of accuracy data.`,
  alternates: {
    canonical: `${BASE_URL}/tony-awards`,
  },
  openGraph: {
    title: 'Tony Awards — Broadway Scorecard',
    description: 'Predictions, all-time leaderboard, and historical accuracy data for the Tony Awards.',
    url: `${BASE_URL}/tony-awards`,
    type: 'website',
    images: [{ url: `${BASE_URL}/og/tony-awards.png`, width: 1200, height: 630, alt: 'Tony Awards — Broadway Scorecard' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tony Awards — Broadway Scorecard',
    description: 'Predictions, leaderboard, and historical accuracy for the Tony Awards.',
  },
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How accurate are critic scores at predicting Tony Awards?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Over 12 Tony seasons (2014-2025), the top 2 shows by aggregated critic score won the Tony 95% of the time. Best Musical is the most predictable category at 90% accuracy. Only 2 winners in over a decade ranked below #2: The Outsiders (2024, #4) and Take Me Out (2022, #5).',
      },
    },
    {
      '@type': 'Question',
      name: 'What is Broadway Scorecard\'s Tony Awards section?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway Scorecard\'s Tony Awards section includes data-driven predictions for every eligible show, an all-time leaderboard of winners and nominees ranked by career awards, and historical accuracy analysis showing how well critic scores predict Tony winners.',
      },
    },
  ],
};

// --- Page ---

export default function TonyAwardsHubPage() {
  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const categories = groupIntoCategories(eligible);
  const historicalWinners = getHistoricalWinners(allShows);

  const totalScored = categories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const totalUpcoming = categories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

  // Leaderboard teaser data
  const leaderboard = getTonyLeaderboard();
  const meta = getTonyNominationsMeta();
  const top3 = leaderboard.slice(0, 3);

  // Top show per category for predictions teaser
  const categoryTeasers = categories
    .filter(cat => cat.shows.length > 0)
    .map(cat => ({
      label: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
      showTitle: cat.shows[0].title,
      score: cat.shows[0].compositeScore,
    }));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
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

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Tony Awards
          </h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            Data-driven Tony Awards analysis &mdash; predictions, accuracy stats, and the all-time leaderboard.
          </p>
        </div>

        {/* Teaser Cards Grid */}
        <div className="grid sm:grid-cols-2 gap-4 mb-10">
          {/* Predictions Teaser */}
          {featureFlags.tonyPredictions && eligible.length > 0 ? (
            <Link href="/tony-awards/predictions" className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">{season.label} Tony Predictions</h2>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-400 mb-3">
                {eligible.length} eligible shows &middot; {totalScored} reviewed {totalUpcoming > 0 && <>&middot; {totalUpcoming} upcoming</>}
              </p>
              {categoryTeasers.length > 0 && (
                <div className="space-y-1.5">
                  {categoryTeasers.slice(0, 4).map(t => (
                    <div key={t.label} className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">{t.label}</span>
                      <span className="text-white font-medium truncate ml-2">
                        {t.showTitle}
                        {t.score !== null && (
                          <span className="text-brand ml-1.5">({t.score})</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-sm text-brand mt-3 group-hover:text-brand-hover transition-colors">
                See full predictions &rarr;
              </p>
            </Link>
          ) : featureFlags.tonyPredictions ? (
            <div className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-2">{season.label} Tony Predictions</h2>
              <p className="text-sm text-gray-400">
                Predictions for the {season.ceremonyYear} season will appear when shows begin opening.
              </p>
            </div>
          ) : null}

          {/* Leaderboard Teaser */}
          {featureFlags.tonyPeople && (
            <Link href="/tony-awards/people" className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">All-Time Leaderboard</h2>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-400 mb-3">
                {meta.totalNominations.toLocaleString()} nominations &middot; {meta.totalWins.toLocaleString()} wins tracked
              </p>
              {top3.length > 0 && (
                <div className="space-y-1.5">
                  {top3.map((p, i) => (
                    <div key={p.ibdbPersonId} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">#{i + 1}</span>
                      <span className="text-white font-medium flex-1 ml-2 truncate">{p.name}</span>
                      <span className="text-brand font-semibold ml-2">{p.wins}W</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-sm text-brand mt-3 group-hover:text-brand-hover transition-colors">
                View full leaderboard &rarr;
              </p>
            </Link>
          )}
        </div>

        {/* Browse Tony Shows */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">Browse Tony Shows</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <Link href="/browse/tony-winners-on-broadway" className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Tony Winners on Broadway</h3>
                  <p className="text-xs text-gray-400 mt-1">Award-winning productions currently playing</p>
                </div>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
            <Link href={`/browse/tony-nominated-${season.ceremonyYear}`} className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">{season.ceremonyYear} Tony Nominees</h3>
                  <p className="text-xs text-gray-400 mt-1">This year&apos;s celebrated shows still playing</p>
                </div>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          </div>
        </section>

        {/* Historical Winners */}
        {historicalWinners.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-2">Recent Tony Winning Shows &amp; Their Scores</h2>
            <p className="text-sm text-gray-400 mb-4">
              How recent Tony winners scored with critics &mdash; showing the relationship between reviews and awards.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-white/5">
                    <th className="pb-3 pr-4">Season</th>
                    <th className="pb-3 pr-4">Show</th>
                    <th className="pb-3 pr-4">Category</th>
                    <th className="pb-3 pr-4 text-right">Score</th>
                    <th className="pb-3 text-right">Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalWinners.map((winner, i) => {
                    const tier = getScoreTier(winner.compositeScore);
                    return (
                      <tr key={`${winner.slug}-${i}`} className="border-b border-white/5">
                        <td className="py-2.5 pr-4 text-sm text-gray-400">{winner.season}</td>
                        <td className="py-2.5 pr-4">
                          <Link href={`/show/${winner.slug}`} className="text-sm font-medium text-white hover:text-brand transition-colors">
                            {winner.title}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-4 text-sm text-gray-400">{winner.category.replace('Best ', '')}</td>
                        <td className="py-2.5 pr-4 text-right">
                          {winner.compositeScore !== null ? (
                            <span className="text-sm font-semibold" style={{ color: tier?.color || '#9ca3af' }}>
                              {winner.compositeScore}
                            </span>
                          ) : (
                            <span className="text-sm text-gray-500">&mdash;</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right text-sm text-gray-500">{winner.reviewCount || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* How Accurate Are Critic Scores? */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-2">How Accurate Are Critic Scores?</h2>
          <p className="text-sm text-gray-400 mb-5">
            We analyzed 12 Tony seasons (2014&ndash;2025) across all four main categories to test how well aggregated critic scores predict winners.
          </p>

          {/* Hero stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { stat: '69%', label: '#1 score wins' },
              { stat: '95%', label: 'Top 2 wins' },
              { stat: '90%', label: 'Best Musical accuracy' },
              { stat: '1.44', label: 'Avg winner rank' },
            ].map(({ stat, label }) => (
              <div key={label} className="rounded-xl border border-white/5 bg-surface-overlay p-3 sm:p-4 text-center">
                <div className="text-2xl sm:text-3xl font-bold text-brand">{stat}</div>
                <div className="text-xs text-gray-400 mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* Field size insight */}
          <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5 mb-5">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Field Size Changes Everything</h3>
            <div className="space-y-2.5">
              {[
                { nominees: '3\u20134 nominees', pct: 92, note: 'Standard Tony field' },
                { nominees: '5\u20136 nominees', pct: 67, note: '' },
                { nominees: '2 nominees', pct: 50, note: 'Coin flip' },
                { nominees: '7+ nominees', pct: 40, note: 'Chaos' },
              ].map(({ nominees, pct, note }) => (
                <div key={nominees} className="flex items-center gap-3">
                  <span className="text-sm text-gray-300 w-28 sm:w-32 flex-shrink-0">{nominees}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-white w-10 text-right">{pct}%</span>
                  {note && <span className="text-xs text-gray-500 hidden sm:inline w-24">{note}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Category breakdown + New vs Revival */}
          <div className="grid sm:grid-cols-2 gap-3 mb-5">
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h3>
              <div className="space-y-2">
                {[
                  { cat: 'Best Musical', pct: '90%', color: 'text-emerald-400' },
                  { cat: 'Best Play', pct: '70%', color: 'text-blue-400' },
                  { cat: 'Revival Play', pct: '60%', color: 'text-gray-300' },
                  { cat: 'Revival Musical', pct: '56%', color: 'text-gray-400' },
                ].map(({ cat, pct, color }) => (
                  <div key={cat} className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">{cat}</span>
                    <span className={`text-sm font-bold ${color}`}>{pct}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">New Works vs. Revivals</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">New works</span>
                  <span className="text-sm font-bold text-emerald-400">80%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">Revivals</span>
                  <span className="text-sm font-bold text-gray-400">58%</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Revivals carry nostalgia, star power, and cultural-moment factors that critic scores don&apos;t fully capture.
              </p>
            </div>
          </div>

          {/* The only 2 real upsets */}
          <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">The Only Times It Failed</h3>
            <p className="text-xs text-gray-500 mb-3">
              In 39 category-seasons, only 2 winners ranked below #2 by critic score.
            </p>
            <div className="space-y-2">
              <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                <div>
                  <span className="text-sm text-white font-medium">The Outsiders</span>
                  <span className="text-xs text-gray-500 ml-2">Best Musical 2024</span>
                </div>
                <span className="text-sm text-amber-400 font-semibold">Ranked #4</span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <div>
                  <span className="text-sm text-white font-medium">Take Me Out</span>
                  <span className="text-xs text-gray-500 ml-2">Revival Play 2022</span>
                </div>
                <span className="text-sm text-amber-400 font-semibold">Ranked #5</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Every other &ldquo;upset&rdquo; was the #2 critic score edging out #1 &mdash; average gap just 2.7 points.
            </p>
          </div>
        </section>

        {/* Footer links */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <div className="flex flex-wrap gap-4">
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology &rarr;
            </Link>
            {featureFlags.criticPages && (
              <Link href="/critics" className="text-brand hover:text-brand-hover transition-colors">
                Critic profiles &rarr;
              </Link>
            )}
            {featureFlags.boxOffice && (
              <Link href="/box-office" className="text-brand hover:text-brand-hover transition-colors">
                Box office data &rarr;
              </Link>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
