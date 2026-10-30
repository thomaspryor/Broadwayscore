/**
 * /biz - Broadway Profitability Scorecard Dashboard
 * Sprint 3: Dashboard Page
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { featureFlags } from '@/config/feature-flags';
import {
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
  getCommercialHeadlineStats,
  getCommercialWeeklySnapshot,
} from '@/lib/data-commercial';
import { getAllShows } from '@/lib/data-core';
import { mixSection, withoutMixRows } from '@/lib/season-findings';
import { selectSeasonAverageBase, selectSeasonHistory } from '@/lib/season-profile';
import { getGrossesWeekEnding } from '@/lib/data-grosses';
import { formatDataDate, formatDevelopmentDate, sortNewestFirst } from '@/lib/biz-format';
import { lossOutcomePhrase, ESTIMATE_SOURCES_NOTE } from '@/lib/commercial-display';
import EmailTomLink from '@/components/EmailTomLink';

import SeasonComparisonTable from '@/components/biz/SeasonComparisonTable';
import SeasonHistoryTable from '@/components/biz/SeasonHistoryTable';
import MixCard from '@/components/biz/MixCard';
import TopicCard from '@/components/biz/TopicCard';
import { formatMillions, TONY_NOMS_HIGH } from '@/lib/investment-topics';
import { getMusicalsSinceReopening, getWhatPredictsTheMoney, getFlopsAndRecoups, getTonyWinners } from '@/lib/data-topic-pages';
import WhoRecoupsCard from '@/components/biz/WhoRecoupsCard';
import RecentDevelopmentsList from '@/components/biz/RecentDevelopmentsList';
import { buildDevelopments } from '@/lib/biz-developments';
import ApproachingRecoupmentCard from '@/components/biz/ApproachingRecoupmentCard';
import AtRiskCard from '@/components/biz/AtRiskCard';
import RecoupmentTable from '@/components/biz/RecoupmentTable';
import AllShowsTable from '@/components/biz/AllShowsTable';
import MoneyGate from '@/components/biz/MoneyGate';
import DesignationLegend from '@/components/biz/DesignationLegend';
import DesignationChips, { DESIGNATION_GUIDE_ID } from '@/components/biz/DesignationChips';
import BizPageTracker from '@/components/biz/BizPageTracker';
import CostCoverageCard from '@/components/box-office/CostCoverageCard';
import { BASE_URL, generateBreadcrumbSchema } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import BizHeader from '@/components/biz/BizHeader';
import CommercialScorecard from '@/components/CommercialScorecard';
import { getMarketDate } from '@/lib/date-utils';

const OG_ALT = 'Broadway Profitability Scorecard: who made money on Broadway, and who lost it';
const PAGE_TITLE = "Broadway Profitability Database: Who Recouped and Who Didn't";

// Headline numbers for the hero and the meta description (BRO-6286).
function formatBillions(n: number): string {
  return n >= 999.5e6 ? `$${(n / 1e9).toFixed(1)}B` : `$${Math.round(n / 1e6)}M`;
}

const HERO = getCommercialHeadlineStats();
const OG_DESCRIPTION =
  `The first public Broadway profitability database. Which shows paid back their investors, and which didn't. Capitalization, weekly running costs and recoupment for ${HERO.productions} commercial productions, from SEC filings, trade press and weekly box office grosses.`;

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: OG_DESCRIPTION,
  alternates: {
    canonical: `${BASE_URL}/biz`,
  },
  openGraph: {
    title: PAGE_TITLE,
    description: OG_DESCRIPTION,
    url: `${BASE_URL}/biz`,
    images: [bizOgImage('home', OG_ALT)],
  },
  twitter: {
    card: 'summary_large_image',
    title: PAGE_TITLE,
    description: OG_DESCRIPTION,
    images: [bizOgImage('home', OG_ALT)],
  },
};

export default function BizDashboard() {
  if (!featureFlags.commercial) notFound();

  // Get data for all sections

  // Season profile: this season vs last season and the 10-season average, and
  // every season with tracked coverage side by side (season-profile.ts).
  const today = getMarketDate('broadway');
  const currentSeason = getSeason(today);
  const currentComparison = currentSeason ? getSeasonComparison(currentSeason) : null;
  const profiles = getSeasonProfiles();
  const seasonHistory = selectSeasonHistory(profiles, currentSeason);
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

  const recentDevelopments = buildDevelopments('short');

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
    { name: 'Profitability Scorecard', url: `${BASE_URL}/biz` },
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
        {/* Header (BRO-6286): mirrors the /biz share card, eyebrow pill, the
            tagline as the lead, then headline numbers and the fine print. */}
        <BizHeader
          title="Broadway Profitability Scorecard"
          tagline="Who made money on Broadway, and who lost it"
          sharePath="/biz"
        >
          <p className="text-base text-gray-400 mt-3 max-w-3xl">
            For the first time ever, Broadway profitability in one public database:
            capitalization, weekly running costs and recoupment for every commercial production
            we can document, built from SEC filings, trade press and The Broadway League&apos;s
            weekly grosses.
          </p>

          <dl className="grid grid-cols-3 gap-3 sm:gap-4 mt-6 max-w-3xl" data-testid="biz-hero-stats">
            {[
              { value: HERO.productions.toLocaleString('en-US'), label: 'commercial productions tracked' },
              { value: formatBillions(HERO.disclosedCapitalization), label: 'in disclosed capitalization' },
              { value: HERO.recouped.toLocaleString('en-US'), label: 'recoupments on record' },
            ].map((stat) => (
              <div key={stat.label} className="card flex flex-col-reverse justify-end px-3 py-3 sm:px-5 sm:py-4">
                <dt className="text-xs sm:text-sm text-gray-400 mt-0.5">{stat.label}</dt>
                <dd className="text-2xl sm:text-3xl font-bold text-white tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>

          <DesignationChips />

          <div className="mt-5 space-y-1">
            {freshness.length > 0 && (
              <p className="text-xs text-fg-muted" data-testid="biz-freshness">
                {freshness.join(' · ')}
              </p>
            )}
            <p className="text-xs text-fg-muted">
              League grosses as published by Playbill and BroadwayWorld. Recoupment estimates are
              our model.{' '}
              <Link href="/methodology#commercial" className="text-brand underline hover:text-brand-hover">
                How we measure
              </Link>
            </p>
            <p className="text-xs text-amber-500/70">{ESTIMATE_SOURCES_NOTE}</p>
            <p className="text-xs text-amber-500/70">Questions, ideas, requests?{' '}<EmailTomLink className="underline hover:text-amber-400" /></p>
          </div>
        </BizHeader>

        {/* Season by season */}
        {seasonHistory.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-3">Season by Season</h2>
            <p className="text-sm text-gray-400 -mt-2 mb-3">How many commercial shows paid back their investors, how much money went in and our estimate of how much has come back. Tap a season for every show.</p>
            <SeasonHistoryTable profiles={seasonHistory} averageProfiles={selectSeasonAverageBase(profiles, currentSeason)} currentSeason={currentSeason} asOf={today} />
          </section>
        )}

        <section className="mb-8">
          <h2 className="text-xl font-bold text-white mb-3">Who Recoups</h2>
          <WhoRecoupsCard findings={recoupFindings} />
          <Link href="/biz/stunt-casting" className="inline-block mt-3 text-sm text-brand hover:text-brand-hover">
            Does star casting pay? Stunt casting since 2004 →
          </Link>
        </section>

        {/* Show-level detail: free with an email (BRO-6210). The season
            table and findings above and the analysis below stay free. */}
        <MoneyGate page="biz-dashboard">
        <CommercialScorecard snapshot={getCommercialWeeklySnapshot(today)} />
        {/* Recent Developments */}
        {recentDevelopments.length > 0 && (
          <section className="mb-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
              <h2 className="text-lg font-bold text-white">Recent Developments</h2>
              <Link href="/biz/developments" className="text-sm text-brand hover:text-brand-hover whitespace-nowrap">
                See all →
              </Link>
            </div>
            <RecentDevelopmentsList items={recentDevelopments} />
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

        {costCoverage && <CostCoverageCard counts={costCoverage.counts} shares={costCoverage.shares} />}


        {/* Designation Legend */}
        <section id={DESIGNATION_GUIDE_ID} className="mb-10 scroll-mt-20">
          <h2 className="text-lg font-bold text-white mb-3">
            Designation Guide
          </h2>
          <DesignationLegend />
        </section>

        {/* Why this exists, in the owner's words (owner, 2026-10-26). Free,
            outside the gate. */}
        <section className="mb-10" data-testid="biz-about">
          <h2 className="text-lg font-bold text-white mb-3">Why I Built This</h2>
          <div className="card rounded-xl p-5 space-y-3 text-sm leading-relaxed text-gray-300">
            <p>
              I&apos;m a theatergoer and an investor, and I wanted to know which Broadway shows were succeeding, which
              were struggling, and which weren&apos;t long for this world. Box office alone tells you very little. A
              show can gross a fortune every week and still be losing money.
            </p>
            <p>
              Every week, hundreds of people pick apart the grosses on Reddit, mostly guessing. The real numbers are
              scattered across SEC filings, tax credit applications and trade press, so I pulled them into one place
              and built a model to fill the gaps. Where you see an estimate, it&apos;s ours, and it&apos;s marked.
            </p>
            <p>
              The industry is drawing the wrong lesson from its losses. Money is flowing to what looks safe: star
              revivals, familiar titles, &ldquo;proven&rdquo; creative teams. The data says that isn&apos;t paying off,
              and the hits often come out of nowhere. If investors can see what actually pays back, maybe more of them
              will back ambitious new work.
            </p>
            <p>
              Producer friends told me to charge for this. It&apos;s always free, because it does more good in public.
            </p>
            <p>
              Spot an error, or have numbers you can share?{' '}
              <Link href="/feedback" className="text-brand hover:text-brand-hover">Tell me</Link>.
            </p>
            <p className="text-white font-medium">Tom Pryor</p>
          </div>
        </section>

        {/* Footer */}
        <footer className="text-sm text-fg-muted border-t border-white/5 pt-6">
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
