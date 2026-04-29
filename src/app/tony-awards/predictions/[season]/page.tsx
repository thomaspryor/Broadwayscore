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
import {
  getTonySeasonWindow,
  getTonySeasonWindowFor,
  getAllPredictionSeasons,
  getEligibleShows,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getSeasonOutcomes,
  getWinnersForSeason,
  hasNominationsBeenAnnounced,
  serializeShow,
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
  const eligible = isCurrent
    ? getEligibleShows(allShows, season)
    : getEligibleShowsForPastSeason(allShows, season);
  const nominationsAnnounced = isCurrent && hasNominationsBeenAnnounced(season);
  const categories = groupIntoCategories(eligible,
    nominationsAnnounced ? { nomineesOnly: true, season } : undefined
  );
  const outcomes = getSeasonOutcomes(allShows, season);

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
            ? `Based on a blend of aggregated critic scores and audience grades, Broadway Scorecard ranks every Tony-eligible show in the ${season.label} season. This combined approach historically predicts Tony winners with higher accuracy than critics alone.`
            : winnerCount > 0
              ? `The ${season.label} Tony season saw ${winnerCount} major category winners. The #1 ranked show won ${rank1Wins} of ${winnerCount} categories.`
              : `The ${season.label} Tony season data includes all eligible shows ranked by blended critic and audience scores.`,
        },
      },
      {
        '@type': 'Question',
        name: 'How are Tony predictions calculated on Broadway Scorecard?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Tony predictions use a blended score combining aggregated critic reviews (from 420+ outlets including NYT, Variety, and Vulture) with audience grades from multiple platforms. This combined approach historically predicts winners more accurately than critics or audiences alone.',
        },
      },
      {
        '@type': 'Question',
        name: 'What is a blended score?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'A blended score combines the CriticScore (aggregated from professional reviews, weighted by outlet tier) with audience data (from platforms like Show-Score and Mezzanine) at a 50/50 ratio. This captures both critical acclaim and audience reception.',
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
              ? 'Tony nominees ranked by blended critic + audience scores. Who will win?'
              : isCurrent
                ? 'Data-driven predictions powered by blended critic scores and audience grades. Every Tony-eligible show ranked by combined consensus.'
                : `How blended critic + audience scores predicted the ${season.ceremonyYear} Tony Awards.`}
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
                Shows are ranked by a 50/50 blend of critic scores and audience grades &mdash; combining
                reviews from dozens of outlets (NYT, Vulture, Variety) with real audience sentiment from
                multiple sources. Use the toggle above to view rankings by Combined, Critics-only, or Audience-only scores.
                These aren&apos;t editorial picks &mdash; they&apos;re what the data says.
              </p>
              <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
                Learn about our scoring methodology &rarr;
              </Link>
            </div>
          </details>
        )}

        {/* Category Sections */}
        <TonyPredictionsClient
          categories={categories}
          outcomes={Object.keys(outcomes).length > 0 ? outcomes : undefined}
          categoryOutcomes={Object.keys(categoryOutcomeStatus).length > 0 ? categoryOutcomeStatus : undefined}
        />

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Rankings are derived from aggregated critic reviews.
            Tony eligibility based on opening dates within the {season.label} season.
            Category classifications (new vs. revival) are subject to official Tony Awards Administration Committee rulings.
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
