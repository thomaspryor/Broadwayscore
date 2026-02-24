import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
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
  hasNominationsBeenAnnounced,
} from '@/lib/data-tony-predictions';

const allSeasons = getAllPredictionSeasons();
const allSeasonLabels = allSeasons.map(s => s.label);

export function generateStaticParams() {
  return allSeasons.map(s => ({ season: s.label }));
}

export function generateMetadata({ params }: { params: { season: string } }): Metadata {
  const season = allSeasons.find(s => s.label === params.season);
  if (!season) return {};

  const title = `Tony Awards Predictions ${season.label} Season`;
  const description = `Data-driven Tony predictions for the ${season.label} Broadway season. Every eligible show ranked by blended critic + audience scores.`;

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

  // How many categories had the #1 scored show win?
  let rank1Wins = 0;
  if (!isCurrent) {
    for (const cat of categories) {
      if (cat.shows.length > 0) {
        const topSlug = cat.shows[0].slug;
        if (outcomes[topSlug] === 'winner') rank1Wins++;
      }
    }
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

        {/* Season Result Summary (past seasons only) */}
        {!isCurrent && winnerCount > 0 && (
          <div className="mb-8 p-4 sm:p-5 rounded-xl border border-amber-500/20 bg-amber-500/5">
            <p className="text-sm text-gray-300">
              <span className="text-amber-400 font-semibold">Season Result:</span>{' '}
              The #1 ranked show won {rank1Wins} of {winnerCount} categories.
              {rank1Wins === winnerCount && ' Perfect prediction season.'}
              {rank1Wins === 0 && ' A season of upsets.'}
            </p>
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
            <summary className="p-4 sm:p-5 cursor-pointer text-sm font-semibold text-white uppercase tracking-wide hover:text-brand transition-colors list-none">
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
