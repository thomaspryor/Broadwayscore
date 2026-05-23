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

  // Softmax win probabilities per category (T=7, same logic as Nominations Center + predictions [season] page).
  const T = 7;
  const categoryWinProbs = new Map<string, Map<string, number>>();
  for (const cat of currentCategories) {
    const scored = cat.shows.filter(s => s.blendedScore != null);
    if (scored.length === 0) continue;
    const exps = scored.map(s => Math.exp(s.blendedScore! / T));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = new Map<string, number>();
    scored.forEach((show, i) => probs.set(show.slug, exps[i] / sum));
    categoryWinProbs.set(cat.key, probs);
  }

  // Build picks data: #1 show per category with thumbnail + probabilities
  const picks = currentCategories
    .filter(cat => cat.shows.length > 0)
    .map(cat => {
      const probs = categoryWinProbs.get(cat.key);
      return {
        key: cat.key,
        label: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
        fullTitle: cat.title,
        show: cat.shows[0],
        winProbability: probs?.get(cat.shows[0].slug) ?? null,
        runnerUp: cat.shows.length > 1 ? cat.shows[1] : null,
        runnerUpProbability: cat.shows.length > 1 ? (probs?.get(cat.shows[1].slug) ?? null) : null,
        totalInCategory: cat.shows.length + cat.upcoming.length,
      };
    });

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
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Tony Awards Predictions</h1>
          <p className="text-gray-400 mt-2 max-w-2xl">
            {nominationsAnnounced
              ? `${currentSeason.label} nominees ranked by our per-category model — critic, audience, and (for Best Play) precursor Awards Score.`
              : `${seasons.length} seasons of data-driven Tony predictions. Each category gets its own blend of critic, audience, and precursor signal.`}
          </p>
        </div>

        {/* Disclaimer: data-driven, not editorial */}
        <div className="mb-6 px-4 py-3 rounded-xl border border-brand/20 bg-brand/5">
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            <span className="text-brand font-semibold">These are data-driven, not editorial.</span>{' '}
            Rankings are what our model outputs when trained on past Tony data — not personal picks.
            Expect surprises when audience buzz or precursor signal pushes a show above conventional favorites.
          </p>
        </div>

        {/* Announcement banner — hidden once win probabilities are live */}
        {!featureFlags.tonyPredictionsOurPick && (
          <div className="mb-6 px-4 py-3 rounded-xl border border-white/8 bg-surface-raised text-sm">
            <span className="text-brand font-semibold">Predictions being released on Thursday</span>
            {' '}— check back for per-category win probabilities ranked by our critic, audience &amp; awards model.
          </div>
        )}

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
                    {/* Win probabilities + component scores */}
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="flex items-stretch gap-2">
                        {pick.winProbability != null && (
                          <div className="flex flex-col items-center justify-center min-w-[44px]">
                            <span className="text-2xl font-bold text-white leading-none">{Math.round(pick.winProbability * 100)}%</span>
                            <span className="text-[9px] text-gray-500 uppercase tracking-wide mt-0.5">Our pick</span>
                          </div>
                        )}
                        {pick.show.gdOdds != null && (
                          <div className="flex flex-col items-center justify-center min-w-[44px] border-l border-white/10 pl-2">
                            <span className="text-2xl font-bold text-amber-400 leading-none">{Math.round(pick.show.gdOdds * 100)}%</span>
                            <span className="text-[9px] text-gray-500 uppercase tracking-wide mt-0.5">Gold Derby</span>
                          </div>
                        )}
                        {pick.winProbability == null && pick.show.gdOdds == null && (
                          <BlendedTrioDisplay
                            blendedScore={pick.show.blendedScore}
                            compositeScore={pick.show.compositeScore}
                            reviewCount={pick.show.reviewCount}
                            status={pick.show.status}
                            audienceGrade={pick.show.audienceGrade}
                            awardsScore={pick.show.awardsScore}
                            awardsWeighted={pick.show.tonyCategoryKey === 'best-play'}
                            size="md"
                            showCrown
                          />
                        )}
                      </div>
                      <BlendedTrioDisplay
                        blendedScore={pick.show.blendedScore}
                        compositeScore={pick.show.compositeScore}
                        reviewCount={pick.show.reviewCount}
                        status={pick.show.status}
                        audienceGrade={pick.show.audienceGrade}
                        awardsScore={pick.show.awardsScore}
                        awardsWeighted={pick.show.tonyCategoryKey === 'best-play'}
                        size="sm"
                        hideScore
                      />
                    </div>
                  </div>
                  {pick.runnerUp && (
                    <p className="text-xs text-gray-500 mt-2.5 truncate border-t border-white/5 pt-2">
                      Runner-up: <span className="text-gray-400 font-medium">{pick.runnerUp.title}</span>
                      {pick.runnerUpProbability != null ? (
                        <span className="text-gray-600 ml-1">({Math.round(pick.runnerUpProbability * 100)}%)</span>
                      ) : pick.runnerUp.blendedScore != null ? (
                        <span className="text-gray-600 ml-1">({Math.round(pick.runnerUp.blendedScore)})</span>
                      ) : null}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Track Record — always expanded; replaces prior collapsible accuracy breakdown */}
        {(() => {
          const completedSummaries = summaries.filter(s => s.hasTonyResults);
          let totalHits = 0;
          let totalCells = 0;
          const misses: Array<{ seasonLabel: string; categoryLabel: string; ourPick: string; tonyWinner: string }> = [];
          // Compute per-category accuracy directly from the same data the hero
          // stat and grid use, so all three displays stay internally consistent
          // even if computeBlendedAccuracyStats is computed via a different path.
          const CAT_COLS = ['Musical', 'Play', 'Revival Musical', 'Revival Play'];
          const catTotals: Record<string, { hits: number; total: number }> = {};
          for (const c of CAT_COLS) catTotals[c] = { hits: 0, total: 0 };
          for (const sum of completedSummaries) {
            for (const h of sum.categoryHighlights) {
              if (!h.winnerTitle) continue;
              totalCells++;
              if (catTotals[h.category]) catTotals[h.category].total++;
              if (h.topShowTitle && h.winnerTitle === h.topShowTitle) {
                totalHits++;
                if (catTotals[h.category]) catTotals[h.category].hits++;
              } else if (h.topShowTitle) {
                misses.push({
                  seasonLabel: sum.season.label,
                  categoryLabel: h.category,
                  ourPick: h.topShowTitle,
                  tonyWinner: h.winnerTitle,
                });
              }
            }
          }
          const accuracyPct = totalCells > 0 ? Math.round((totalHits / totalCells) * 1000) / 10 : 0;
          const byCategory = CAT_COLS.map(c => ({
            category: `Best ${c}`,
            hits: catTotals[c].hits,
            total: catTotals[c].total,
            pct: catTotals[c].total > 0 ? Math.round((catTotals[c].hits / catTotals[c].total) * 1000) / 10 : 0,
          }));
          const sortedCompleted = [...completedSummaries].sort((a, b) => b.season.ceremonyYear - a.season.ceremonyYear);
          return (
            <section className="mb-10 rounded-xl border border-white/5 bg-surface-overlay p-5 sm:p-6">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Track Record</h2>

              {/* Hero stat */}
              <div className="text-center pb-5 mb-5 border-b border-white/5">
                <div className="text-5xl sm:text-6xl font-bold text-brand leading-none mb-2">
                  {totalHits} <span className="text-gray-500">/</span> {totalCells}
                </div>
                <p className="text-sm text-gray-300">
                  Our #1 pick won across {stats.seasonCount} Tony seasons &middot; <span className="text-white font-semibold">{accuracyPct}% accuracy</span>
                </p>
              </div>

              {/* Per-category bars */}
              <div className="space-y-3 mb-6">
                {byCategory.map(({ category, hits, total, pct }) => (
                  <div key={category} className="flex items-center gap-3">
                    <span className="text-sm text-gray-300 w-36 sm:w-44 flex-shrink-0 truncate">{category}</span>
                    <div className="flex-1 h-6 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500/80' : pct >= 80 ? 'bg-brand/80' : 'bg-blue-500/70'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 w-10 text-right tabular-nums">{hits}/{total}</span>
                    <span className="text-sm font-bold text-white w-14 text-right tabular-nums">{pct}%</span>
                  </div>
                ))}
              </div>

              {/* Season-by-season grid */}
              <div className="mb-6">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Season by season</h3>
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 uppercase tracking-wide">
                        <th className="text-left font-medium pb-2 px-1">Season</th>
                        {CAT_COLS.map(c => (
                          <th key={c} className="text-center font-medium pb-2 px-1">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedCompleted.map(sum => (
                        <tr key={sum.season.label} className="border-t border-white/5">
                          <td className="py-2 px-1 text-white font-medium whitespace-nowrap">{sum.season.label}</td>
                          {CAT_COLS.map(c => {
                            const h = sum.categoryHighlights.find(x => x.category === c);
                            if (!h || !h.winnerTitle) {
                              return <td key={c} className="text-center text-gray-600 py-2 px-1">&mdash;</td>;
                            }
                            const hit = h.topShowTitle === h.winnerTitle;
                            return (
                              <td key={c} className="text-center py-2 px-1">
                                {hit ? (
                                  <span className="text-emerald-400" aria-label="hit">✓</span>
                                ) : (
                                  <span className="text-amber-400" aria-label="miss">✗</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Where we missed */}
              {misses.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Where we missed ({misses.length})</h3>
                  <p className="text-xs text-gray-500 mb-3">
                    Our #1 didn&apos;t match the Tony winner in these category-seasons. Most are voter-sentiment upsets (cultural significance, star power) that blended scores can&apos;t fully capture.
                  </p>
                  <div className="space-y-2">
                    {misses.map(m => (
                      <div key={`${m.seasonLabel}-${m.categoryLabel}`} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                        <div className="text-xs text-gray-500 mb-1">
                          {m.seasonLabel} &middot; Best {m.categoryLabel}
                        </div>
                        <div className="text-sm text-gray-300">
                          <span className="text-gray-400">Our #1:</span> <span className="text-white">{m.ourPick}</span>
                          <span className="text-gray-600 mx-2">&rarr;</span>
                          <span className="text-gray-400">Tony:</span> <span className="text-amber-400 font-medium">{m.tonyWinner}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          );
        })()}

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
                      Our #1 pick won {rank1Wins}/{categoriesWithResults} categories
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
