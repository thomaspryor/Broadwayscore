import Link from 'next/link';
import type { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getScoreTier } from '@/components/show-cards/ScoreBadge';
import { featureFlags } from '@/config/feature-flags';
import { getBrowsePageConfig } from '@/config/browse-pages';
import { getTonyLeaderboard, getTonyNominationsMeta } from '@/lib/data-tony-noms';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
  getHistoricalWinners,
  hasNominationsBeenAnnounced,
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
        text: 'Aggregated critic scores have a strong track record predicting Tony winners. See our multi-season accuracy analysis on the Tony Awards Predictions page for detailed stats across all four main categories.',
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
  const nominationsAnnounced = hasNominationsBeenAnnounced(season);
  const categories = groupIntoCategories(eligible,
    nominationsAnnounced ? { nomineesOnly: true, season } : undefined
  );
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
      score: cat.shows[0].blendedScore ?? cat.shows[0].compositeScore,
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
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
          {/* Predictions Teaser — hidden until tonyPredictionsOurPick is enabled (full reveal) */}
          {featureFlags.tonyPredictions && featureFlags.tonyPredictionsOurPick && eligible.length > 0 ? (
            <div className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group relative">
              <Link href={`/tony-awards/predictions/${season.label}`} className="block">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold text-white uppercase tracking-wide">{season.label} Tony Predictions</h2>
                  <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                <p className="text-sm text-gray-400 mb-3">
                  {eligible.length} eligible shows &middot; {totalScored} reviewed {totalUpcoming > 0 && <>&middot; {totalUpcoming} upcoming</>}
                </p>
                {categoryTeasers.length > 0 && (
                  <div className="space-y-1.5">
                    {categoryTeasers.slice(0, 4).map(t => (
                      <div key={t.label} className="flex items-center gap-2 text-sm">
                        <span className="text-gray-500 flex-shrink-0 truncate">{t.label}</span>
                        <span className="text-white font-medium truncate flex-1">{t.showTitle}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-sm text-brand mt-3 group-hover:text-brand-hover transition-colors">
                  See full predictions &rarr;
                </p>
              </Link>
              <Link
                href="/tony-awards/predictions"
                className="block mt-2 pt-2 border-t border-white/5 text-xs text-gray-400 hover:text-brand transition-colors"
              >
                Track record &amp; past seasons &rarr;
              </Link>
            </div>
          ) : null}

          {/* Winners 2026 Teaser */}
          {nominationsAnnounced && (
            <Link href="/tony-awards/winners-2026" className="p-4 sm:p-5 rounded-xl border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 transition-colors group">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">2026 Tony Winners</h2>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-amber-400 transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-400 mb-3">
                Our predicted winners for all 26 Tony categories — ceremony June 8
              </p>
              <p className="text-sm text-amber-400 mt-3 group-hover:text-amber-300 transition-colors">
                See predicted winners &rarr;
              </p>
            </Link>
          )}

          {/* Nominees Teaser */}
          {nominationsAnnounced && (
            <Link href="/tony-awards/nominees" className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">{season.label} Nominees</h2>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-400 mb-3">
                All 26 categories with critic scores, audience grades &amp; win odds
              </p>
              <div className="space-y-1.5">
                {categoryTeasers.slice(0, 3).map(t => (
                  <div key={t.label} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500 flex-shrink-0 truncate">{t.label}</span>
                    <span className="text-white font-medium truncate flex-1">{t.showTitle}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm text-brand mt-3 group-hover:text-brand-hover transition-colors">
                View all nominees &rarr;
              </p>
            </Link>
          )}

          {/* Leaderboard Teaser */}
          {featureFlags.tonyPeople && (
            <Link href="/tony-awards/people" className="p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">All-Time Leaderboard</h2>
                <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
        {(() => {
          // Try current ceremony year, then fall back to previous year
          const currentSlug = `tony-nominated-${season.ceremonyYear}`;
          const prevSlug = `tony-nominated-${season.ceremonyYear - 1}`;
          const nomineeBrowseSlug = getBrowsePageConfig(currentSlug) ? currentSlug : prevSlug;
          const hasNomineeBrowse = !!getBrowsePageConfig(nomineeBrowseSlug);
          const nomineeYear = getBrowsePageConfig(currentSlug) ? season.ceremonyYear : season.ceremonyYear - 1;
          return (
            <section className="mb-10">
              <h2 className="text-xl font-bold text-white mb-4">Browse Tony Shows</h2>
              <div className={`grid ${hasNomineeBrowse ? 'sm:grid-cols-2' : ''} gap-4`}>
                <Link href="/browse/tony-winners-on-broadway" className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Tony Winners on Broadway</h3>
                      <p className="text-xs text-gray-400 mt-1">Award-winning productions currently playing</p>
                    </div>
                    <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
                {hasNomineeBrowse && (
                  <Link href={`/browse/${nomineeBrowseSlug}`} className="p-4 rounded-xl border border-white/5 bg-surface-overlay hover:bg-white/[0.04] transition-colors group">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-white">{nomineeYear} Tony Nominees</h3>
                        <p className="text-xs text-gray-400 mt-1">{nomineeYear === season.ceremonyYear ? 'This year\'s' : 'Last year\'s'} celebrated shows still playing</p>
                      </div>
                      <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0 ml-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </Link>
                )}
              </div>
            </section>
          );
        })()}

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
                    const displayScore = winner.blendedScore ?? winner.compositeScore;
                    const tier = getScoreTier(displayScore);
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
                          {displayScore !== null ? (
                            <span className="text-sm font-semibold" style={{ color: tier?.color || '#9ca3af' }}>
                              {Math.round(displayScore)}
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
            <Link href="/tony-awards/predictions" className="text-sm text-brand hover:text-brand-hover transition-colors mt-4 inline-block">
              See all seasons &rarr;
            </Link>
          </section>
        )}

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
