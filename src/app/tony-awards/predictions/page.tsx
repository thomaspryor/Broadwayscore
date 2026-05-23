import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { getOptimizedImageUrl } from '@/lib/images';
import { BlendedTrioDisplay } from '@/components/show-cards';
import { TrackRecord } from '@/components/tony/TrackRecord';
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

  // Derive accuracy from the same summaries the visible TrackRecord uses so the
  // FAQ snippet Google indexes stays in sync with what users see on the page.
  // stats.blendedRank1WinPct is computed via a separate stale path that doesn't
  // reflect current recipes (e.g. shows 86% when the visible UI shows 90.7%).
  let faqHits = 0;
  let faqCells = 0;
  for (const sum of summaries) {
    if (!sum.hasTonyResults) continue;
    for (const h of sum.categoryHighlights) {
      if (!h.winnerTitle) continue;
      faqCells++;
      if (h.topShowTitle && h.winnerTitle === h.topShowTitle) faqHits++;
    }
  }
  const faqPct = faqCells > 0 ? Math.round((faqHits / faqCells) * 1000) / 10 : 0;
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How accurate is the per-category prediction model at predicting Tony Awards?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Each Tony category uses its own blend recipe tuned across ${stats.seasonCount} Tony seasons. Best Musical: 60% critic + 20% audience + 20% precursor awards. Best Play: 100% precursor awards combining Drama League/OCC/Drama Desk top-category signal with Pulitzer, NYDCC, and Tony nomination breadth. Best Revival of a Musical: 10% critic + 70% audience + 20% broad precursor signal. Best Revival of a Play: 20% critic + 60% audience + 20% Awards Score. Best Musical and Best Revival of a Musical also penalize shows without a Best Direction of a Musical Tony nomination (no winner has lacked one in 11 seasons) and jukebox musicals (no wins outside the COVID-truncated 2019-20 ceremony). Across ${stats.seasonCount} seasons the model picks the eventual winner ${faqHits} of ${faqCells} times (${faqPct}%).`,
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

        {/* Current Season CTA — replaces full 4-card layout. Search traffic
            (GSC, last 90d) overwhelmingly lands on /predictions/<season>; the
            umbrella page was duplicating that. This single prominent card
            sends users to the season detail. */}
        {picks.length > 0 && (
          <section className="mb-10">
            <Link
              href={`/tony-awards/predictions/${currentSeason.label}`}
              className="block p-5 sm:p-6 rounded-xl border border-brand/20 bg-gradient-to-br from-brand/[0.08] to-brand/[0.02] hover:from-brand/[0.12] hover:to-brand/[0.04] transition-colors group"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-brand uppercase tracking-wider mb-1">
                    {nominationsAnnounced ? 'Live · Winner Predictions' : 'Live · Predictions'}
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2">
                    {currentSeason.label} Tony Awards
                  </h2>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                    {totalUpcoming > 0 && (
                      <span>{totalUpcoming} show{totalUpcoming !== 1 ? 's' : ''} still to open</span>
                    )}
                    {!nominationsAnnounced && (
                      <span>Nominations &sim; May {currentSeason.ceremonyYear}</span>
                    )}
                    <span>Ceremony &sim; June {currentSeason.ceremonyYear}</span>
                  </div>
                  <p className="text-sm text-gray-300 mt-3 group-hover:text-white transition-colors">
                    See our picks for all 4 categories &rarr;
                  </p>
                </div>
                <svg className="w-8 h-8 text-brand flex-shrink-0 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          </section>
        )}

        {/* Track Record — always expanded on the umbrella page */}
        <section className="mb-10 max-w-3xl mx-auto rounded-xl border border-white/5 bg-surface-overlay p-5 sm:p-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Track Record</h2>
          <TrackRecord summaries={summaries} seasonCount={stats.seasonCount} />
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
