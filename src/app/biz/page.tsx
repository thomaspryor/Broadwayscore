/**
 * /biz - Broadway Money Scorecard Dashboard
 * Sprint 3: Dashboard Page
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { featureFlags } from '@/config/feature-flags';
import {
  getSeasonsWithCommercialData,
  getSeasonStats,
  getShowsApproachingRecoupment,
  getShowsAtRisk,
  getRecentRecoupments,
  getRecentClosings,
  getUpcomingClosings,
  getAllOpenShowsWithCommercial,
  getCommercialLastUpdated,
  getCommercialModelLastRun,
  getBoxOfficeCostCoverage,
  getSeason,
  getSeasonComparison,
  getSeasonProfiles,
  getRecoupFindings,
} from '@/lib/data-commercial';
import { getAllShows } from '@/lib/data-core';
import { mixSection, withoutMixRows } from '@/lib/season-findings';
import { getGrossesWeekEnding } from '@/lib/data-grosses';
import { formatDataDate, formatDevelopmentDate, sortNewestFirst } from '@/lib/biz-format';
import { lossOutcomePhrase, ESTIMATE_SOURCES_NOTE } from '@/lib/commercial-display';

import SeasonStatsCard from '@/components/biz/SeasonStatsCard';
import SeasonComparisonTable from '@/components/biz/SeasonComparisonTable';
import SeasonHistoryTable from '@/components/biz/SeasonHistoryTable';
import MixCard from '@/components/biz/MixCard';
import TopicCard from '@/components/biz/TopicCard';
import { formatMillions, TONY_NOMS_HIGH } from '@/lib/investment-topics';
import { getMusicalsSinceReopening, getWhatPredictsTheMoney, getFlopsAndRecoups, getTonyWinners } from '@/lib/data-topic-pages';
import WhoRecoupsCard from '@/components/biz/WhoRecoupsCard';
import RecentDevelopmentsList, { type DevelopmentItem } from '@/components/biz/RecentDevelopmentsList';
import ApproachingRecoupmentCard from '@/components/biz/ApproachingRecoupmentCard';
import AtRiskCard from '@/components/biz/AtRiskCard';
import RecoupmentTable from '@/components/biz/RecoupmentTable';
import AllShowsTable from '@/components/biz/AllShowsTable';
import MoneyGate from '@/components/biz/MoneyGate';
import DesignationLegend from '@/components/biz/DesignationLegend';
import BizPageTracker from '@/components/biz/BizPageTracker';
import CostCoverageCard from '@/components/box-office/CostCoverageCard';
import { BASE_URL, generateBreadcrumbSchema } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import ShareButton from '@/components/biz/ShareButton';
import { getMarketDate } from '@/lib/date-utils';

const OG_ALT = 'Broadway Money Scorecard: who made money on Broadway, and who lost it';
const OG_DESCRIPTION =
  'Who made money on Broadway, and who lost it. Every commercial show sorted from Miracle to Flop, with capitalization, weekly running costs and recoupment, estimated from SEC filings and trade press.';

export const metadata: Metadata = {
  title: { absolute: 'Broadway Money Scorecard' },
  description: OG_DESCRIPTION,
  alternates: {
    canonical: `${BASE_URL}/biz`,
  },
  openGraph: {
    title: 'Broadway Money Scorecard',
    description: OG_DESCRIPTION,
    url: `${BASE_URL}/biz`,
    images: [bizOgImage('home', OG_ALT)],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Money Scorecard',
    description: OG_DESCRIPTION,
    images: [bizOgImage('home', OG_ALT)],
  },
};

// Generate recent developments from actual data
function generateRecentDevelopments(): DevelopmentItem[] {
  // Past events (recoupments, closings) carry their ISO date so they can be
  // interleaved newest first; upcoming closings and at-risk rows follow.
  const past: Array<{ isoDate: string; item: DevelopmentItem }> = [];

  // Add recent recoupments (last 12 months)
  const recentRecoupments = getRecentRecoupments(12);
  for (const show of recentRecoupments.slice(0, 4)) {
    past.push({
      isoDate: show.recoupDate,
      item: {
        date: formatDevelopmentDate(show.recoupDate),
        type: 'recouped',
        showTitle: show.title,
        showSlug: show.slug,
        // No week count for a year-only recoupment date or one reported after closing (calculateWeeksToRecoup → null).
        description: show.weeksToRecoup === null || show.weeksIsEstimate
          ? (show.reportedAfterClosing ? 'recouped, reported after closing' : 'recouped')
          : `recouped about ${show.weeksToRecoup} weeks after ${show.fromCommercialRun ? 'its commercial run began' : 'opening'}`,
      },
    });
  }

  // Add recent closings that didn't recoup (last 3 months)
  const recentClosings = getRecentClosings(3);
  for (const show of recentClosings.slice(0, 3)) {
    const desc = lossOutcomePhrase({ designation: show.designation, designationBasis: show.designationBasis ?? undefined }, 'closing');
    past.push({
      isoDate: show.closingDate,
      item: {
        date: formatDevelopmentDate(show.closingDate),
        type: 'closing',
        showTitle: show.title,
        showSlug: show.slug,
        description: desc,
      },
    });
  }

  const items: DevelopmentItem[] = sortNewestFirst(past, (p) => p.isoDate).map((p) => p.item);

  // Add upcoming closings (announced)
  const upcomingClosings = getUpcomingClosings();
  for (const show of upcomingClosings.slice(0, 2)) {
    items.push({
      date: formatDevelopmentDate(show.closingDate),
      type: 'closing-announced',
      showTitle: show.title,
      showSlug: show.slug,
      description: 'closing announced',
    });
  }

  // Add shows at risk (if any pass strict criteria)
  const atRiskShows = getShowsAtRisk();
  for (const show of atRiskShows.slice(0, 2)) {
    items.push({
      date: 'Now',
      type: 'at-risk',
      showTitle: show.title,
      showSlug: show.slug,
      description: '4-week average gross below estimated break-even',
    });
  }

  return items.slice(0, 8);
}

export default function BizDashboard() {
  if (!featureFlags.commercial) notFound();

  // Get data for all sections
  // Dynamically get seasons with commercial data (most recent first)
  const allSeasons = getSeasonsWithCommercialData();
  // Show up to 4 most recent seasons
  const displaySeasons = allSeasons.slice(0, 4);
  const seasonStats = displaySeasons.map(season => getSeasonStats(season));

  // Season profile: this season vs last season and the 10-season average, and
  // the last 11 seasons side by side (season-profile.ts).
  const today = getMarketDate('broadway');
  const currentSeason = getSeason(today);
  const currentComparison = currentSeason ? getSeasonComparison(currentSeason) : null;
  const profiles = getSeasonProfiles();
  const seasonHistory = profiles
    .filter((p) => !currentSeason || p.season <= currentSeason)
    .slice(0, 11);
  // The Season Report's visuals (owner, 2026-10-21); its Key Findings are linked, not repeated.
  const scores = new Map(getAllShows().map((s) => [s.slug, s.compositeScore == null ? null : Math.round(s.compositeScore)]));
  const recoupFindings = getRecoupFindings(scores, today);
  const musicalsTopic = getMusicalsSinceReopening(today);
  const reviewsTopic = getWhatPredictsTheMoney(today);
  const flopsTopic = getFlopsAndRecoups(today);
  const tonyTopic = getTonyWinners(today);
  const newMusicals = reviewsTopic.buckets.find((b) => b.id === 'new-musical')!;
  const mixCard = currentSeason ? mixSection(profiles, currentSeason, currentComparison) : null;

  // Unreleased (BRO-5007): running shows by break-even band, moved here from /box-office.
  const costCoverage = featureFlags.commercial && featureFlags.boxOfficeV2 ? getBoxOfficeCostCoverage() : null;

  const approachingRecoupment = getShowsApproachingRecoupment();
  const atRiskShows = getShowsAtRisk();
  const recentRecoupments = getRecentRecoupments(24);
  const allOpenShows = getAllOpenShowsWithCommercial();

  const recentDevelopments = generateRecentDevelopments();

  // Freshness: three clocks, stated separately so nobody reads a research
  // date as the box office date (BRO-4623 P1-1).
  const grossesWeek = getGrossesWeekEnding();
  const modelRun = getCommercialModelLastRun();
  const lastUpdated = getCommercialLastUpdated();
  const freshness = [
    grossesWeek ? `Box office through week ending ${formatDataDate(grossesWeek) ?? grossesWeek}` : null,
    modelRun ? `Model run ${formatDataDate(modelRun) ?? modelRun}` : null,
    lastUpdated ? `Research updated ${formatDataDate(lastUpdated) ?? lastUpdated}` : null,
  ].filter((part): part is string => !!part);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Money Scorecard', url: `${BASE_URL}/biz` },
  ]);

  const bizFaqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'What does it mean for a Broadway show to recoup?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Recoupment means a Broadway show has earned back its initial investment (capitalization) through ticket sales and other revenue. A show that has recouped is profitable for its investors. Most Broadway shows fail to recoup; only about 25% of shows earn back their investment.',
        },
      },
      {
        '@type': 'Question',
        name: 'How much does it cost to produce a Broadway show?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Broadway capitalization varies widely. A straight play typically costs $3-8 million, while a musical ranges from $10-25 million. Large spectacle musicals can cost $25 million or more. Weekly running costs for a musical average $600,000-$900,000.',
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, bizFaqSchema]) }}
      />
    <div className="min-h-screen bg-surface">
      {/* Track page views (analytics only: /biz never shows the blocking
          page-view wall; BRO-4623 P1-15) */}
      <BizPageTracker page="biz-dashboard" gate={false} />
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
        {/* Back Link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-white">
                Broadway Money Scorecard
              </h1>
              <p className="text-gray-400 mt-2">
                Who made money on Broadway, and who lost it
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Capitalization and recoupment from SEC filings and trade press. Weekly
                box office from The Broadway League, as published by Playbill and
                BroadwayWorld. Recoupment estimates are our model.
              </p>
              {freshness.length > 0 && (
                <p className="text-xs text-gray-500 mt-1" data-testid="biz-freshness">
                  {freshness.join(' · ')}
                </p>
              )}
              <p className="text-xs text-amber-500/70 mt-1">
                {ESTIMATE_SOURCES_NOTE}{' '}
                <Link href="/methodology#commercial" className="underline hover:text-amber-400">
                  How we measure
                </Link>
              </p>
            </div>
            <ShareButton path="/biz" title="Broadway Money Scorecard" className="shrink-0 order-first self-end sm:order-none sm:self-start" />
            {/* JSON/CSV download buttons removed (owner decision, BRO-4721): they
                only opened a waitlist and read as unfinished. GatedDownloadButtons
                is kept for when downloads ship. */}
          </div>
        </div>

        {/* This season vs last season and the 10-season average */}
        {currentComparison && (
          <section className="mb-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
              <h2 className="text-xl font-bold text-white">
                The {currentComparison.season} Season{currentComparison.inProgress ? ' So Far' : ''}
              </h2>
              <Link href={`/biz/season/${currentComparison.season}`} className="text-sm text-brand hover:text-brand-hover whitespace-nowrap">
                Every show →
              </Link>
            </div>
            <SeasonComparisonTable comparison={mixCard?.columns.length ? withoutMixRows(currentComparison) : currentComparison} />
          </section>
        )}

        {mixCard && mixCard.columns.length > 0 && (
          <section className="mb-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-1">
              <h2 className="text-xl font-bold text-white">Production Mix</h2>
              <Link href="/season-report" className="text-sm text-brand hover:text-brand-hover whitespace-nowrap">
                Key findings in the Season Report →
              </Link>
            </div>
            <p className="text-sm text-gray-400 mb-3">Originals and revivals, each split into musicals and plays.</p>
            <MixCard columns={mixCard.columns} overallRows={mixCard.overallRows} withinRows={mixCard.withinRows} />
          </section>
        )}

        <section className="mb-8">
          <h2 className="text-xl font-bold text-white mb-3">Topics</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-testid="topic-cards">
            <TopicCard
              href="/biz/musicals-since-reopening"
              title="Musicals since the reopening"
              headline={`${musicalsTopic.originals.recouped} of ${musicalsTopic.originals.total} original musicals opened have recouped`}
              detail={`Every commercial musical opened since September 2021, ${musicalsTopic.total} in all.`}
            />
            <TopicCard
              href="/biz/reviews-and-money"
              title="What predicts the money"
              headline={`${newMusicals.tonyNoms.high.recouped} of ${newMusicals.tonyNoms.high.total} new musicals with ${TONY_NOMS_HIGH}+ Tony nominations recouped`}
              detail="Critic scores, audience scores and Tony results against recoupment, for new musicals, revivals and plays."
            />
            {flopsTopic.flops[0] && (
            <TopicCard
              href="/biz/biggest-flops"
              title="Biggest flops"
              headline={`${flopsTopic.flops[0].title}: ${formatMillions(flopsTopic.flops[0].capitalization)} raised, labelled ${flopsTopic.flops[0].designation}`}
              detail="Loss-labelled shows since the reopening, ranked by the capital they raised."
            />
            )}
            {flopsTopic.recoups[0] && (
            <TopicCard
              href="/biz/fastest-recoups"
              title="Fastest recoupments"
              headline={`${flopsTopic.recoups[0].title} recouped in about ${flopsTopic.recoups[0].weeksToRecoup} weeks`}
              detail="Shows ranked by weeks from opening night to recoupment."
            />
            )}
            <TopicCard
              href="/biz/tony-winners"
              title="Tony winners"
              headline={`${tonyTopic.recouped} of ${tonyTopic.decided} Best Musical and Best Play winners recouped`}
              detail="What happened to the investors in each winner since 2021-22."
            />
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-bold text-white mb-3">Who Recoups</h2>
          <WhoRecoupsCard findings={recoupFindings} />
          <Link href="/biz/stunt-casting" className="inline-block mt-3 text-sm text-brand hover:text-brand-hover">
            Does star casting pay? Stunt casting since 2004 →
          </Link>
        </section>

        {/* Season Stats Row */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
            By Season
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {seasonStats.map((stats) => (
              <SeasonStatsCard
                key={stats.season}
                season={stats.season}
                capitalAtRisk={stats.capitalAtRisk}
                recoupedCount={stats.recoupedCount}
                totalShows={stats.totalShows}
                recoupedShows={stats.recoupedShows}
              />
            ))}
          </div>
        </section>

        {/* Season by season */}
        {seasonHistory.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-3">Season by Season</h2>
            <SeasonHistoryTable profiles={seasonHistory} currentSeason={currentSeason} asOf={today} />
          </section>
        )}

        {costCoverage && <CostCoverageCard counts={costCoverage.counts} shares={costCoverage.shares} />}

        {/* Show-level detail: free with an email (BRO-6210). Everything
            above is the free landing; the tier guide below stays free too. */}
        <MoneyGate page="biz-dashboard">
        {/* Recent Developments */}
        {recentDevelopments.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-bold text-white mb-3">
              Recent Developments
            </h2>
            <RecentDevelopmentsList items={recentDevelopments} />
          </section>
        )}

        {/* Approaching Recoupment */}
        {approachingRecoupment.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-4">
              Approaching Recoupment
            </h2>
            <p className="text-gray-400 text-sm mb-4">
              Running shows whose model estimate is at least 50% recouped even in the
              low case. Estimates, not announcements.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {approachingRecoupment.slice(0, 6).map((show) => (
                <ApproachingRecoupmentCard key={show.slug} {...show} />
              ))}
            </div>
          </section>
        )}

        {/* At Risk Shows */}
        {atRiskShows.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-4">
              Struggling / At Risk
            </h2>
            <p className="text-gray-400 text-sm mb-4">
              Running shows whose 4-week average gross is below estimated break-even
              and whose model estimate is under 30% recouped even in the high case.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {atRiskShows.slice(0, 6).map((show) => (
                <AtRiskCard key={show.slug} {...show} />
              ))}
            </div>
          </section>
        )}

        {/* Recent Recoupments Table */}
        {recentRecoupments.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-4">
              Recent Recoupments
            </h2>
            <p className="text-gray-400 text-sm mb-4">
              Shows reported to have recouped in the last 2 years.
            </p>
            <RecoupmentTable shows={recentRecoupments} />
          </section>
        )}

        {/* All Open Shows Table */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">
            All Currently Running Shows
          </h2>
          <p className="text-gray-400 text-sm mb-4">
            Commercial data for every open Broadway production we track.
          </p>
          <AllShowsTable shows={allOpenShows} initialLimit={10} />
        </section>

        </MoneyGate>

        {/* Designation Legend */}
        <section className="mb-10">
          <h2 className="text-lg font-bold text-white mb-3">
            Designation Guide
          </h2>
          <DesignationLegend />
        </section>

        {/* Footer */}
        <footer className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p className="mb-2">
            <strong className="text-gray-400">Note:</strong> Figures marked ~ are
            estimates. Capitalization and recoupment come from SEC filings and trade
            press (Broadway Journal, Broadway News, Deadline, Variety, Playbill, The
            New York Times). Percent recouped, ranges and break-even are our model
            unless a source is cited. Weekly box office grosses are The Broadway
            League&apos;s reported figures, as published by Playbill and BroadwayWorld.
          </p>
          <p>
            Spotted an error? Send a correction with a source link through our{' '}
            <Link href="/feedback" className="text-brand hover:text-brand-hover">
              feedback form
            </Link>{' '}
            (category &ldquo;Content Error&rdquo;).
          </p>
          <div className="flex gap-4 mt-3">
            <Link
              href="/methodology#commercial"
              className="text-brand hover:text-brand-hover"
            >
              Methodology →
            </Link>
          </div>
        </footer>
      </div>
    </div>
    </>
  );
}
