import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { getOptimizedImageUrl } from '@/lib/images';
import { BlendedTrioDisplay } from '@/components/show-cards';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import {
  getTonySeasonWindow,
  getAllPredictionSeasons,
  getEligibleShows,
  groupIntoCategories,
  computeBlendedAccuracyStats,
  getSeasonSummary,
  hasNominationsBeenAnnounced,
} from '@/lib/data-tony-predictions';

const currentSeason = getTonySeasonWindow();

export function generateMetadata(): Metadata {
  return {
    title: 'Tony Awards Predictions — Per-Category Critic, Audience & Awards Score',
    description: `Data-driven Tony Awards predictions across ${getAllPredictionSeasons().length} seasons. Each category gets its own blend of critic, audience, and (for Best Play) precursor Awards Score.`,
    alternates: {
      canonical: `${BASE_URL}/tony-awards/predictions`,
    },
    openGraph: {
      title: 'Tony Awards Predictions — Broadway Scorecard',
      description: 'Every Tony-eligible show ranked by our per-category prediction model — critic, audience, and precursor signal.',
      url: `${BASE_URL}/tony-awards/predictions`,
      type: 'website',
      images: [{ url: `${BASE_URL}/og/tony-predictions.png`, width: 1200, height: 630, alt: 'Tony Awards Predictions' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Tony Awards Predictions — Broadway Scorecard',
      description: 'Every Tony-eligible show ranked by our per-category prediction model.',
    },
  };
}

export default function TonyPredictionsOverviewPage() {
  if (!featureFlags.tonyPredictions) notFound();

  const allShows = getBroadwayShows();
  const seasons = getAllPredictionSeasons();
  const stats = computeBlendedAccuracyStats(allShows);

  // Current season data — nomination-aware
  const currentEligible = getEligibleShows(allShows, currentSeason);
  const nominationsAnnounced = hasNominationsBeenAnnounced(currentSeason);
  const currentCategories = groupIntoCategories(currentEligible,
    nominationsAnnounced ? { nomineesOnly: true, season: currentSeason } : undefined
  );

  // Build picks data: #1 show per category with thumbnail
  const picks = currentCategories
    .filter(cat => cat.shows.length > 0)
    .map(cat => ({
      key: cat.key,
      label: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
      fullTitle: cat.title,
      show: cat.shows[0],
      runnerUp: cat.shows.length > 1 ? cat.shows[1] : null,
      totalInCategory: cat.shows.length + cat.upcoming.length,
    }));

  // Upcoming shows count (awaiting reviews)
  const totalUpcoming = currentCategories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

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
        name: 'How accurate is the per-category prediction model at predicting Tony Awards?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Over ${stats.seasonCount} Tony seasons, the per-category model (critic + audience + precursor Awards Score) predicts the Tony winner ${stats.blendedRank1WinPct}% of the time — a ${stats.improvement}-point improvement over critics alone (${stats.criticsOnlyRank1WinPct}%). Based on ${stats.categorySeasonCount} category-seasons of data.`,
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
            {nominationsAnnounced
              ? `${currentSeason.label} nominees ranked by our per-category model — critic, audience, and (for Best Play) precursor Awards Score.`
              : `${seasons.length} seasons of data-driven Tony predictions. Each category gets its own blend of critic, audience, and precursor signal.`}
          </p>
        </div>

        {/* Current Season Picks — Prominent */}
        {picks.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">
                {currentSeason.label} {nominationsAnnounced ? 'Winner Predictions' : 'Predictions'}
              </h2>
              <Link
                href={`/tony-awards/predictions/${currentSeason.label}`}
                className="text-sm text-brand hover:text-brand-hover transition-colors"
              >
                See all categories &rarr;
              </Link>
            </div>
            {/* Context bar — upcoming shows, key dates */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 text-xs text-gray-500">
              {totalUpcoming > 0 && (
                <span>{totalUpcoming} show{totalUpcoming !== 1 ? 's' : ''} still to open</span>
              )}
              {!nominationsAnnounced && (
                <span>Nominations &sim; May {currentSeason.ceremonyYear}</span>
              )}
              <span>Ceremony &sim; June {currentSeason.ceremonyYear}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {picks.map(pick => (
                <Link
                  key={pick.label}
                  href={`/tony-awards/predictions/${currentSeason.label}#${pick.key}`}
                  className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group"
                >
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{pick.label}</p>
                  <div className="flex items-center gap-3">
                    {/* Thumbnail */}
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
                      {pick.show.thumbnailPath ? (
                        <img
                          src={getOptimizedImageUrl(pick.show.thumbnailPath, 'thumbnail')}
                          alt={pick.show.title}
                          className="w-full h-full object-cover"
                          width={80}
                          height={80}
                          loading="eager"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xl">🎭</div>
                      )}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-bold text-white truncate group-hover:text-brand transition-colors">
                        {pick.show.title}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {pick.show.venue}
                      </p>
                    </div>
                    {/* Blended trio: tier + bold blended above critic + audience boxes */}
                    <BlendedTrioDisplay
                      blendedScore={pick.show.blendedScore}
                      compositeScore={pick.show.compositeScore}
                      reviewCount={pick.show.reviewCount}
                      status={pick.show.status}
                      audienceGrade={pick.show.audienceGrade}
                      size="md"
                      showCrown
                    />
                  </div>
                  {pick.runnerUp && (
                    <p className="text-xs text-gray-500 mt-2.5 truncate border-t border-white/5 pt-2">
                      Runner-up: <span className="text-gray-400 font-medium">{pick.runnerUp.title}</span>
                      {pick.runnerUp.blendedScore != null && (
                        <span className="text-gray-600 ml-1">({Math.round(pick.runnerUp.blendedScore)})</span>
                      )}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Accuracy One-Liner + Expandable Details */}
        <section className="mb-10">
          <div className="flex items-baseline gap-2 mb-3">
            <p className="text-sm text-gray-300">
              Our #1 pick wins the Tony <span className="text-brand font-bold">{stats.blendedRank1WinPct}%</span> of the time &mdash; across {stats.seasonCount} seasons and {stats.categorySeasonCount} category-seasons.
            </p>
          </div>

          <details className="group rounded-xl border border-white/5 bg-surface-overlay">
            <summary className="p-4 sm:p-5 cursor-pointer text-sm font-semibold text-gray-400 hover:text-white transition-colors list-none [&::-webkit-details-marker]:hidden flex items-center justify-between">
              <span>Accuracy breakdown</span>
              <svg className="w-4 h-4 text-gray-500 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-5">
              {/* Hero stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { stat: `${stats.blendedRank1WinPct}%`, label: 'Per-category #1 wins' },
                  { stat: `${stats.criticsOnlyRank1WinPct}%`, label: 'Critics-only #1 wins' },
                  { stat: `${stats.improvement >= 0 ? '+' : ''}${stats.improvement}pts`, label: 'Improvement vs critics-only' },
                  { stat: `${stats.blendedAvgWinnerRank}`, label: 'Avg winner rank' },
                ].map(({ stat, label }) => (
                  <div key={label} className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-center">
                    <div className="text-xl font-bold text-brand">{stat}</div>
                    <div className="text-xs text-gray-400 mt-1">{label}</div>
                  </div>
                ))}
              </div>

              {/* Field size insight */}
              <div>
                <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Field Size Changes Everything</h3>
                <div className="space-y-2.5">
                  {stats.fieldSizeData.filter(d => d.count >= 2).map(({ label, pct, note, count }) => (
                    <div key={label} className="flex items-center gap-3">
                      <span className="text-sm text-gray-300 w-28 sm:w-32 flex-shrink-0">{label}</span>
                      <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand/70"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm font-semibold text-white w-10 text-right">{pct}%</span>
                      <span className="text-xs text-gray-500 hidden sm:inline w-24">{note} ({count})</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Category breakdown + New vs Revival */}
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
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
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
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
                    Revivals carry nostalgia, star power, and cultural-moment factors that blended scores don&apos;t fully capture.
                  </p>
                </div>
              </div>

              {/* Upsets */}
              {stats.upsets.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">The Only Times It Failed</h3>
                  <p className="text-xs text-gray-500 mb-3">
                    Across {stats.categorySeasonCount} category-seasons, {stats.upsets.length} winner{stats.upsets.length !== 1 ? 's' : ''} ranked below #2 among nominees by blended score.
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
                    Every other &ldquo;upset&rdquo; was the #2 blended score edging out #1.
                  </p>
                </div>
              )}
            </div>
          </details>
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
            <Link href="/tony-awards/people" className="text-brand hover:text-brand-hover transition-colors">
              All-time leaderboard &rarr;
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
