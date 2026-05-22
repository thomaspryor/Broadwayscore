import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { getOptimizedImageUrl } from '@/lib/images';
import { BlendedTrioDisplay } from '@/components/show-cards';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import { SeasonSelect } from '@/components/SeasonSelect';
import TonyPredictionsClient from '@/components/TonyPredictionsClient';
import { CategorySection, SHOW_LEVEL_CATEGORIES } from '@/components/tony-noms/CategorySection';
import { getNomineesByCategory } from '@/lib/data-tony-nominees';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import {
  getTonySeasonWindow,
  getTonySeasonWindowFor,
  getAllPredictionSeasons,
  getEligibleShows,
  getEligibleShowsForPastSeason,
  getIneligibleShows,
  groupIntoCategories,
  getSeasonOutcomes,
  getWinnersForSeason,
  hasNominationsBeenAnnounced,
  serializeShow,
  computeBlendedAccuracyStats,
} from '@/lib/data-tony-predictions';

const allSeasons = getAllPredictionSeasons();
const allSeasonLabels = allSeasons.map(s => s.label);

export function generateStaticParams() {
  return allSeasons.map(s => ({ season: s.label }));
}

export function generateMetadata({ params }: { params: { season: string } }): Metadata {
  const season = allSeasons.find(s => s.label === params.season);
  if (!season) return {};

  const title = `Tony Awards Predictions ${season.label} — Who Will Win?`;
  const description = `Data-driven Tony predictions for the ${season.label} Broadway season. Every eligible show ranked by blended critic + audience scores. Updated as new reviews come in.`;

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/tony-awards/predictions/${season.label}`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/tony-awards/predictions/${season.label}`,
      type: 'article',
      images: [{ url: `${BASE_URL}/og/tony-predictions.png`, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default function TonySeasonPredictionsPage({ params }: { params: { season: string } }) {
  if (!featureFlags.tonyPredictions) notFound();
  if (!/^\d{4}-\d{4}$/.test(params.season)) notFound();

  const season = allSeasons.find(s => s.label === params.season);
  if (!season) notFound();

  const current = getTonySeasonWindow();
  const isCurrent = season.label === current.label;

  const allShows = getBroadwayShows();
  // Single source of truth for accuracy stats — same function as /tony-awards/predictions overview.
  const accuracyStats = computeBlendedAccuracyStats(allShows);
  const blendedHits = Math.round((accuracyStats.blendedRank1WinPct / 100) * accuracyStats.categorySeasonCount);
  const criticHits = Math.round((accuracyStats.criticsOnlyRank1WinPct / 100) * accuracyStats.categorySeasonCount);

  // All 26 nominee categories (4 major + 8 performer + 14 craft) for this season.
  // Used to render performer/craft categories below the 4-major TonyPredictionsClient.
  const allNomineeCategories = getNomineesByCategory(season);
  const nonMajorCategories = allNomineeCategories.filter(c => !SHOW_LEVEL_CATEGORIES.has(c.title));
  const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
  const ceremonyDate = seasonRecord?.ceremonyDate ?? null;
  const eligible = isCurrent
    ? getEligibleShows(allShows, season)
    : getEligibleShowsForPastSeason(allShows, season);
  const nominationsAnnounced = isCurrent && hasNominationsBeenAnnounced(season);
  // Use nomineesOnly mode whenever Tony nominees are known: every past season,
  // and the current season once nominations are announced. This routes shows
  // by their actual nominated category from awards.json instead of the
  // shows.json type/isRevival flags (which are sometimes mis-set).
  const useNomineesOnly = !isCurrent || nominationsAnnounced;
  const categories = groupIntoCategories(eligible,
    useNomineesOnly ? { nomineesOnly: true, season } : undefined
  );
  const outcomes = getSeasonOutcomes(allShows, season);

  // Shows ruled ineligible by the Tony Administration Committee, grouped by
  // category. Surfaced as a footer under each category so visitors who looked
  // for a missing show see why it's missing rather than assuming the site
  // dropped it. Empty groups are simply not rendered.
  const ineligibleByCategory = getIneligibleShows(allShows, season).reduce<
    Record<string, Array<{ slug: string; title: string; note: string }>>
  >((acc, item) => {
    if (!acc[item.categoryKey]) acc[item.categoryKey] = [];
    acc[item.categoryKey].push({ slug: item.slug, title: item.title, note: item.note });
    return acc;
  }, {});

  const totalScored = categories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const totalUpcoming = categories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

  // For past seasons, compute a result summary
  const outcomeValues = Object.values(outcomes);
  const winnerCount = outcomeValues.filter(o => o === 'winner').length;

  // Build per-category report card for past seasons.
  // Winner lookup uses awards.json directly so a show whose isRevival flag
  // is mis-set in shows.json (e.g., A Soldier's Play 2020 won Best Revival
  // of a Play but is flagged isRevival:false) still appears in the right
  // category card.
  const reportCard = !isCurrent && winnerCount > 0
    ? (() => {
        const winnersByCategory = getWinnersForSeason(season);
        const showById = new Map(allShows.map(s => [s.id, s]));
        return categories.map(cat => {
          const predicted = cat.shows[0] || null;
          const winnerShowId = winnersByCategory.get(cat.title);
          const winnerShow = winnerShowId ? showById.get(winnerShowId) : null;
          const winner = winnerShow ? serializeShow(winnerShow, cat.key as Parameters<typeof serializeShow>[1]) : null;
          const correct = !!(predicted && winner && predicted.slug === winner.slug);
          const winnerRankInOurList = winner
            ? cat.shows.findIndex(s => s.slug === winner.slug)
            : -1;
          return {
            category: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
            categoryKey: cat.key,
            predicted,
            winner,
            correct,
            winnerRank: winnerRankInOurList >= 0 ? winnerRankInOurList + 1 : null,
          };
        }).filter(rc => rc.winner);
      })()
    : [];

  // How many of our #1 picks won? Count from the same source we render.
  const rank1Wins = reportCard.filter(rc => rc.correct).length;
  const reportCardCount = reportCard.length;
  // Map of categoryKey → 'correct' | 'missed' for the list section badges
  const categoryOutcomeStatus: Record<string, { status: 'correct' | 'missed'; winnerTitle: string; winnerRank: number | null; predictedTitle: string | null }> = {};
  for (const rc of reportCard) {
    if (!rc.winner) continue;
    categoryOutcomeStatus[rc.categoryKey] = {
      status: rc.correct ? 'correct' : 'missed',
      winnerTitle: rc.winner.title,
      winnerRank: rc.winnerRank,
      predictedTitle: rc.predicted?.title || null,
    };
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Predictions', url: `${BASE_URL}/tony-awards/predictions` },
    { name: season.label, url: `${BASE_URL}/tony-awards/predictions/${season.label}` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: isCurrent
          ? `What Broadway shows are likely to win Tony Awards in ${season.ceremonyYear}?`
          : `Which shows won Tony Awards in the ${season.label} season?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: isCurrent
            ? `Broadway Scorecard ranks every Tony-eligible show in the ${season.label} season using a per-category blend of critic scores, audience grades, and (for Best Play) a precursor Awards Score. The model was tuned against 11 years of Tony history.`
            : winnerCount > 0
              ? `The ${season.label} Tony season saw ${winnerCount} major category winners. The #1 ranked show won ${rank1Wins} of ${winnerCount} categories.`
              : `The ${season.label} Tony season data includes all eligible shows ranked by our per-category prediction model.`,
        },
      },
      {
        '@type': 'Question',
        name: 'How are Tony predictions calculated on Broadway Scorecard?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Each Tony category has its own blend recipe, tuned against ${accuracyStats.seasonCount} years of Tony seasons. Best Musical weights 45% critic / 55% audience. Best Play uses 40% critic / 40% audience / 20% Awards Score (precursor signal from Drama League, OCC, and Drama Desk). Best Revival of a Musical ranks purely on audience grade; Best Revival of a Play uses 20% critic / 60% audience / 20% Awards Score. Across the ${accuracyStats.seasonCount}-season backtest the category-specific approach correctly picked the eventual winner ${blendedHits} of ${accuracyStats.categorySeasonCount} contests (${accuracyStats.blendedRank1WinPct}%) — vs ${criticHits} of ${accuracyStats.categorySeasonCount} (${accuracyStats.criticsOnlyRank1WinPct}%) for critics alone.`,
        },
      },
      {
        '@type': 'Question',
        name: 'What is the Awards Score?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'A 0-100 score derived from a show’s nominations at the three precursor industry awards — Drama League (weighted 1.0), Outer Critics Circle (0.9), and Drama Desk (0.7). The matching top category (Outstanding Musical / Play / Revival) earns +30 × tier weight for a win or +10 × tier weight for a nomination. Other nominations are then weighted by the importance of the category — Book / Music / Lyrics / Score (A+ tier, weight 2.0), Direction / Lead Acting / Choreography (A tier, 1.5), Featured Acting / Orchestrations (B tier, 1.0), Design (C tier, 0.5). The weighted-nominations total is normalized by an eligible-pool ceiling so plays and musicals are comparable. Awards Score only contributes to the Best Play prediction; for other categories it’s shown for transparency but not weighted.',
        },
      },
      {
        '@type': 'Question',
        name: 'How often are Tony predictions updated?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Predictions update automatically as new reviews are published and audience scores change. During awards season (April through June), rankings can shift daily as last-minute reviews come in.',
        },
      },
    ],
  };

  // ItemList per Tony category — matches visible page structure
  const categoryItemLists = categories.filter(cat => cat.shows.length > 0).map(cat => ({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${cat.title} - Tony Awards ${season.label}`,
    itemListElement: cat.shows.slice(0, 10).map((show, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'TheaterEvent',
        name: show.title,
        url: `${BASE_URL}/show/${show.slug}`,
        location: {
          '@type': 'PerformingArtsTheater',
          name: show.venue || 'Broadway Theater',
          address: show.venue || 'New York, NY',
        },
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      },
    })),
  }));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema, ...categoryItemLists]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/tony-awards/predictions" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Predictions
        </Link>

        {/* Header + Season Selector */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h1 className="text-3xl sm:text-4xl font-bold text-white">
              Tony Awards Predictions
            </h1>
            <SeasonSelect
              basePath="/tony-awards/predictions"
              seasons={allSeasonLabels}
              currentSeason={season.label}
            />
          </div>
          <p className="text-gray-400 mt-2 max-w-2xl">
            {nominationsAnnounced
              ? 'Tony nominees ranked by our per-category model — critic, audience, and (for Best Play) precursor Awards Score.'
              : winnerCount > 0
                ? `How our per-category model would have predicted the ${season.ceremonyYear} Tony Awards.`
                : 'Data-driven predictions powered by per-category blends of critic, audience, and precursor-award signal — tuned on 11 years of Tony history.'}
          </p>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
            <span>{eligible.length} eligible shows</span>
            <span className="text-gray-600">&middot;</span>
            <span>{totalScored} reviewed</span>
            {totalUpcoming > 0 && (
              <>
                <span className="text-gray-600">&middot;</span>
                <span>{totalUpcoming} upcoming</span>
              </>
            )}
          </div>
        </div>

        {/* Report Card (past seasons only) */}
        {reportCard.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-white">Prediction Report Card</h2>
              <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                rank1Wins === reportCardCount ? 'bg-emerald-500/20 text-emerald-400' :
                rank1Wins >= reportCardCount * 0.75 ? 'bg-blue-500/20 text-blue-400' :
                rank1Wins >= reportCardCount * 0.5 ? 'bg-amber-500/20 text-amber-400' :
                'bg-red-500/20 text-red-400'
              }`}>
                {rank1Wins}/{reportCardCount}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {reportCard.map(rc => (
                <div key={rc.category} className={`p-4 rounded-xl border-2 ${rc.correct ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/5'}`}>
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{rc.category}</p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wide ${
                      rc.correct
                        ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/40'
                        : 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40'
                    }`}>
                      {rc.correct ? (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Correct
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Missed{rc.winnerRank ? ` (#${rc.winnerRank})` : ''}
                        </>
                      )}
                    </span>
                  </div>
                  {/* Predicted #1 */}
                  {rc.predicted && (
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
                        {rc.predicted.thumbnailPath ? (
                          <img src={getOptimizedImageUrl(rc.predicted.thumbnailPath, 'thumbnail')} alt={rc.predicted.title} className="w-full h-full object-cover" width={40} height={40} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-sm">🎭</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500">Our #1 pick</p>
                        <p className="text-sm font-medium text-white truncate">{rc.predicted.title}</p>
                      </div>
                      <BlendedTrioDisplay
                        blendedScore={rc.predicted.blendedScore}
                        compositeScore={rc.predicted.compositeScore}
                        reviewCount={rc.predicted.reviewCount}
                        status={rc.predicted.status}
                        audienceGrade={rc.predicted.audienceGrade}
                        awardsScore={rc.predicted.awardsScore}
                        awardsWeighted={rc.predicted.tonyCategoryKey === 'best-play'}
                        size="sm"
                      />
                    </div>
                  )}
                  {/* Actual winner (only show if different from predicted) */}
                  {rc.winner && !rc.correct && (
                    <div className="flex items-center gap-3 pt-2 border-t border-white/5">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
                        {rc.winner.thumbnailPath ? (
                          <img src={getOptimizedImageUrl(rc.winner.thumbnailPath, 'thumbnail')} alt={rc.winner.title} className="w-full h-full object-cover" width={40} height={40} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-sm">🏆</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-amber-400">Actual winner</p>
                        <p className="text-sm font-medium text-white truncate">{rc.winner.title}</p>
                      </div>
                      <BlendedTrioDisplay
                        blendedScore={rc.winner.blendedScore}
                        compositeScore={rc.winner.compositeScore}
                        reviewCount={rc.winner.reviewCount}
                        status={rc.winner.status}
                        audienceGrade={rc.winner.audienceGrade}
                        awardsScore={rc.winner.awardsScore}
                        awardsWeighted={rc.winner.tonyCategoryKey === 'best-play'}
                        size="sm"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Post-Nomination Banner */}
        {nominationsAnnounced && (
          <div className="mb-8 p-4 sm:p-5 rounded-xl border border-brand/20 bg-brand/5">
            <p className="text-sm text-gray-300">
              <span className="text-brand font-semibold">Nominations announced</span> &mdash; showing only nominees, ranked by blended score to predict winners.
            </p>
          </div>
        )}

        {/* How This Works (current season only, pre-noms) */}
        {isCurrent && !nominationsAnnounced && (
          <details className="mb-10 rounded-xl border border-white/5 bg-surface-overlay">
            <summary className="p-4 sm:p-5 cursor-pointer text-sm font-semibold text-white uppercase tracking-wide hover:text-brand transition-colors list-none [&::-webkit-details-marker]:hidden">
              How This Works
            </summary>
            <div className="px-4 sm:px-5 pb-4 sm:pb-5">
              <p className="text-sm text-gray-400 leading-relaxed">
                Each Tony category gets its own recipe, tuned against {accuracyStats.seasonCount} years of Tony history. The model
                correctly picked the winner in {blendedHits} of {accuracyStats.categorySeasonCount} contests ({accuracyStats.blendedRank1WinPct}%) across that backtest, vs {criticHits} of {accuracyStats.categorySeasonCount} ({accuracyStats.criticsOnlyRank1WinPct}%) for
                critic-only:
              </p>
              <ul className="text-sm text-gray-400 leading-relaxed mt-3 space-y-1.5 list-disc pl-5">
                <li><span className="text-white font-medium">Best Musical:</span> 45% critic + 55% audience.</li>
                <li><span className="text-white font-medium">Best Play:</span> 40% critic + 40% audience + 20% Awards Score (precursor signal).</li>
                <li><span className="text-white font-medium">Best Revival of a Musical:</span> ranked purely on audience grade.</li>
                <li><span className="text-white font-medium">Best Revival of a Play:</span> 20% critic + 60% audience + 20% Awards Score.</li>
              </ul>
              <p className="text-sm text-gray-400 leading-relaxed mt-3">
                Awards Score combines Drama League (weight 1.0), OCC (0.9), and Drama Desk (0.7) signal,
                with each nomination weighted by category importance &mdash; top categories like Best Musical
                are credited via a +30 win / +10 nom bonus, then non-top nominations are tiered (Book/Music/Lyrics
                A+ = 2.0, Direction/Lead Acting A = 1.5, Featured/Orchestrations B = 1.0, Design C = 0.5). The
                Awards Score is zero pre-precursor, which makes Best Play reduce to a true 50/50 critic+audience
                composite until early May. Use the toggle above to view rankings by Combined, Critics-only, or
                Audience-only.
              </p>
              <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
                Learn about our scoring methodology &rarr;
              </Link>
              <p className="text-xs text-gray-500 leading-relaxed mt-4 pt-3 border-t border-white/5">
                Score model updated 2026-05-16: Awards Score now weights each precursor nomination by category
                importance (tier S/A+/A/B/C). Backtest accuracy {blendedHits} of {accuracyStats.categorySeasonCount} contests ({accuracyStats.blendedRank1WinPct}%).
              </p>
            </div>
          </details>
        )}

        {/* Category Sections — 4 major (our model has predictions for these) */}
        <TonyPredictionsClient
          categories={categories}
          outcomes={Object.keys(outcomes).length > 0 ? outcomes : undefined}
          categoryOutcomes={Object.keys(categoryOutcomeStatus).length > 0 ? categoryOutcomeStatus : undefined}
          ineligibleByCategory={Object.keys(ineligibleByCategory).length > 0 ? ineligibleByCategory : undefined}
        />

        {/* Performer + craft categories — no model predictions, just nominee data + market odds */}
        {nonMajorCategories.length > 0 && (
          <section className="mt-10">
            <div className="mb-4">
              <h2 className="text-xl font-bold text-white">Performer &amp; Craft Categories</h2>
              <p className="text-sm text-gray-400 mt-1">
                Our model doesn&apos;t predict these — they&apos;re shown with Gold Derby, Kalshi, and Polymarket odds plus precursor signal.
              </p>
            </div>
            {nonMajorCategories.map(cat => (
              <CategorySection key={cat.key} category={cat} ceremonyDate={ceremonyDate} />
            ))}
          </section>
        )}

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Rankings are derived from aggregated critic reviews.
            Tony eligibility based on opening dates within the {season.label} season.
            Category classifications (new vs. revival) are subject to official Tony Awards Administration Committee rulings.
          </p>
          <p className="mt-3 text-xs text-gray-600">
            Score model updated 2026-05-16. Awards Score now uses tier-weighted precursor nominations
            (Drama League, OCC, Drama Desk). Backtest accuracy: {blendedHits} of {accuracyStats.categorySeasonCount} contests ({accuracyStats.blendedRank1WinPct}%) across {accuracyStats.seasonCount} years of Tony history.
          </p>
          <div className="flex flex-wrap gap-4 mt-3">
            <Link href="/tony-awards/predictions" className="text-brand hover:text-brand-hover transition-colors">
              All seasons &rarr;
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
