import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import {
  getTonySeasonWindow,
  getAllPredictionSeasons,
  getEligibleShows,
  groupIntoCategories,
  computeAccuracyStats,
  getSeasonSummary,
} from '@/lib/data-tony-predictions';

const currentSeason = getTonySeasonWindow();

export function generateMetadata(): Metadata {
  return {
    title: 'Tony Awards Predictions — Every Season Ranked by Critic Scores',
    description: `Data-driven Tony Awards predictions across ${getAllPredictionSeasons().length} seasons. See how critic scores predicted Tony winners with ${currentSeason.label} predictions and historical accuracy data.`,
    alternates: {
      canonical: `${BASE_URL}/tony-awards/predictions`,
    },
    openGraph: {
      title: 'Tony Awards Predictions — Broadway Scorecard',
      description: 'Every Tony-eligible show ranked by critic scores, with historical accuracy analysis.',
      url: `${BASE_URL}/tony-awards/predictions`,
      type: 'website',
      images: [{ url: `${BASE_URL}/og/tony-predictions.png`, width: 1200, height: 630, alt: 'Tony Awards Predictions' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Tony Awards Predictions — Broadway Scorecard',
      description: 'Every Tony-eligible show ranked by critic scores.',
    },
  };
}

export default function TonyPredictionsOverviewPage() {
  if (!featureFlags.tonyPredictions) notFound();

  const allShows = getBroadwayShows();
  const seasons = getAllPredictionSeasons();
  const stats = computeAccuracyStats(allShows);

  // Current season data for the callout card
  const currentEligible = getEligibleShows(allShows, currentSeason);
  const currentCategories = groupIntoCategories(currentEligible);
  const currentScored = currentCategories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const categoryTeasers = currentCategories
    .filter(cat => cat.shows.length > 0)
    .map(cat => ({
      label: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
      showTitle: cat.shows[0].title,
      score: cat.shows[0].compositeScore,
    }));

  // Season summaries for the grid
  const summaries = seasons.map(s => getSeasonSummary(allShows, s));

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Predictions', url: `${BASE_URL}/tony-awards/predictions` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How accurate are critic scores at predicting Tony Awards?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Over ${stats.seasonCount} Tony seasons, the top 2 shows by aggregated critic score won the Tony ${stats.top2WinPct}% of the time. Best Musical is the most predictable category. Based on ${stats.categorySeasonCount} category-seasons of data.`,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/tony-awards" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Tony Awards
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Tony Awards Predictions</h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            {seasons.length} seasons of data-driven Tony predictions. Every eligible show ranked by aggregated critic scores.
          </p>
        </div>

        {/* Current Season Callout */}
        {currentEligible.length > 0 && (
          <Link
            href={`/tony-awards/predictions/${currentSeason.label}`}
            className="block mb-10 p-4 sm:p-5 rounded-xl border border-brand/20 bg-brand/5 hover:bg-brand/10 transition-colors group"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">{currentSeason.label} Predictions</h2>
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 bg-brand/20 text-brand rounded">Current</span>
              </div>
              <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <p className="text-sm text-gray-400 mb-3">
              {currentEligible.length} eligible shows &middot; {currentScored} reviewed
            </p>
            {categoryTeasers.length > 0 && (
              <div className="space-y-1.5">
                {categoryTeasers.slice(0, 4).map(t => (
                  <div key={t.label} className="flex items-center justify-between text-sm gap-2">
                    <span className="text-gray-500 flex-shrink-0">{t.label}</span>
                    <span className="text-white font-medium truncate">{t.showTitle}</span>
                    {t.score !== null && (
                      <span className="text-brand flex-shrink-0">({t.score})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-sm text-brand mt-3 group-hover:text-brand-hover transition-colors">
              See full predictions &rarr;
            </p>
          </Link>
        )}

        {/* Accuracy Stats Section */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-2">How Accurate Are Critic Scores?</h2>
          <p className="text-sm text-gray-400 mb-5">
            Across {stats.categorySeasonCount} category-seasons over {stats.seasonCount} Tony ceremonies.
          </p>

          {/* Hero stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { stat: `${stats.rank1WinPct}%`, label: '#1 score wins' },
              { stat: `${stats.top2WinPct}%`, label: 'Top 2 wins' },
              { stat: `${stats.byCategory[0]?.pct || 0}%`, label: 'Best Musical accuracy' },
              { stat: `${stats.avgWinnerRank}`, label: 'Avg winner rank' },
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
              {stats.fieldSizeData.map(({ label, pct, note }) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="text-sm text-gray-300 w-28 sm:w-32 flex-shrink-0">{label}</span>
                  <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-white w-10 text-right">{pct}%</span>
                  <span className="text-xs text-gray-500 hidden sm:inline w-24">{note}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Category breakdown + New vs Revival */}
          <div className="grid sm:grid-cols-2 gap-3 mb-5">
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h3>
              <div className="space-y-2">
                {stats.byCategory.map(({ category, pct }) => (
                  <div key={category} className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">{category}</span>
                    <span className={`text-sm font-bold ${pct >= 80 ? 'text-emerald-400' : pct >= 65 ? 'text-blue-400' : 'text-gray-400'}`}>{pct}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">New Works vs. Revivals</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">New works</span>
                  <span className={`text-sm font-bold ${stats.newWorksAccuracy >= 70 ? 'text-emerald-400' : 'text-gray-400'}`}>{stats.newWorksAccuracy}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">Revivals</span>
                  <span className={`text-sm font-bold ${stats.revivalsAccuracy >= 70 ? 'text-emerald-400' : 'text-gray-400'}`}>{stats.revivalsAccuracy}%</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Revivals carry nostalgia, star power, and cultural-moment factors that critic scores don&apos;t fully capture.
              </p>
            </div>
          </div>

          {/* Upsets */}
          {stats.upsets.length > 0 && (
            <div className="rounded-xl border border-white/5 bg-surface-overlay p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">The Only Times It Failed</h3>
              <p className="text-xs text-gray-500 mb-3">
                Across {stats.categorySeasonCount} category-seasons, {stats.upsets.length} winner{stats.upsets.length !== 1 ? 's' : ''} ranked below #2 among nominees by critic score.
              </p>
              <div className="space-y-2">
                {stats.upsets.map((upset, i) => (
                  <div key={`${upset.season}-${upset.category}`} className={`flex items-center justify-between py-1.5 ${i < stats.upsets.length - 1 ? 'border-b border-white/5' : ''}`}>
                    <div>
                      <span className="text-sm text-white font-medium">{upset.winner}</span>
                      <span className="text-xs text-gray-500 ml-2">{upset.category} {upset.season}</span>
                    </div>
                    <span className="text-sm text-amber-400 font-semibold">Ranked #{upset.rank}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Every other &ldquo;upset&rdquo; was the #2 critic score edging out #1.
              </p>
            </div>
          )}
        </section>

        {/* Season Grid */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">Browse by Season</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {summaries.map(summary => {
              const s = summary.season;
              const bestMusicalWinner = summary.categoryHighlights.find(h => h.category === 'Musical')?.winnerTitle;
              const categoriesWithResults = summary.categoryHighlights.filter(h => h.winnerTitle).length;
              const rank1Wins = summary.categoryHighlights.filter(h => {
                if (!h.winnerTitle || !h.topShowTitle) return false;
                return h.winnerTitle === h.topShowTitle;
              }).length;

              return (
                <Link
                  key={s.label}
                  href={`/tony-awards/predictions/${s.label}`}
                  className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-white">{s.label}</span>
                    <div className="flex items-center gap-2">
                      {summary.isCurrent && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 bg-brand/20 text-brand rounded">Live</span>
                      )}
                      <svg className="w-4 h-4 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    {summary.eligibleCount} eligible &middot; {summary.scoredCount} scored
                  </p>
                  {summary.hasTonyResults && bestMusicalWinner && (
                    <p className="text-xs text-gray-400 truncate">
                      <span className="text-amber-400">Best Musical:</span> {bestMusicalWinner}
                    </p>
                  )}
                  {summary.hasTonyResults && categoriesWithResults > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      #1 score won {rank1Wins}/{categoriesWithResults} categories
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        </section>

        {/* Footer */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <div className="flex flex-wrap gap-4">
            <Link href="/tony-awards" className="text-brand hover:text-brand-hover transition-colors">
              Tony Awards hub &rarr;
            </Link>
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology &rarr;
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
