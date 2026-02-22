import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import { SeasonSelect } from '@/components/SeasonSelect';
import TonyPredictionsTable from '@/components/TonyPredictionsTable';
import {
  getTonySeasonWindow,
  getTonySeasonWindowFor,
  getAllPredictionSeasons,
  getEligibleShows,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getSeasonOutcomes,
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
  const description = `Data-driven Tony predictions for the ${season.label} Broadway season. Every eligible show ranked by aggregated critic scores.`;

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
  const categories = groupIntoCategories(eligible);
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
            ? `Based on aggregated critic scores, Broadway Scorecard ranks every Tony-eligible show in the ${season.label} season. Historically, shows with the highest critic scores have a strong track record at the Tony Awards.`
            : `The ${season.label} Tony season saw ${winnerCount} major category winners. The #1 critic-scored show won ${rank1Wins} of ${winnerCount} categories.`,
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
              Tony Predictions
            </h1>
            <SeasonSelect
              basePath="/tony-awards/predictions"
              seasons={allSeasonLabels}
              currentSeason={season.label}
            />
          </div>
          <p className="text-gray-400 mt-2 max-w-2xl">
            {isCurrent
              ? 'Data-driven predictions powered by aggregated critic scores. Every Tony-eligible show ranked by review consensus.'
              : `How critic scores predicted the ${season.ceremonyYear} Tony Awards.`}
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
              The #1 critic-scored show won {rank1Wins} of {winnerCount} categories.
              {rank1Wins === winnerCount && ' Perfect prediction season.'}
              {rank1Wins === 0 && ' A season of upsets.'}
            </p>
          </div>
        )}

        {/* How This Works (current season only) */}
        {isCurrent && (
          <div className="mb-10 p-4 sm:p-5 rounded-xl border border-white/5 bg-surface-overlay">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-2">How This Works</h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Shows are ranked by their aggregated CriticScore &mdash; a weighted average of reviews from dozens of outlets including
              The New York Times, Vulture, Variety, and more. Historically, the Best Musical Tony winner has
              been among the top-scored eligible shows in almost every recent season.
              These aren&apos;t editorial picks &mdash; they&apos;re what the collective critical consensus says.
            </p>
            <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
              Learn about our scoring methodology &rarr;
            </Link>
          </div>
        )}

        {/* Category Sections */}
        {categories.reduce<{ elements: React.ReactNode[]; runningIndex: number }>(
          (acc, cat) => {
            acc.elements.push(
              <TonyPredictionsTable
                key={cat.key}
                title={cat.title}
                description={cat.description}
                shows={cat.shows}
                upcoming={cat.upcoming}
                startIndex={acc.runningIndex}
                outcomes={Object.keys(outcomes).length > 0 ? outcomes : undefined}
              />
            );
            acc.runningIndex += cat.shows.length + cat.upcoming.length;
            return acc;
          },
          { elements: [], runningIndex: 0 }
        ).elements}

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
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology &rarr;
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
