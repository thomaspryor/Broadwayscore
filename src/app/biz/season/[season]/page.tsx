/**
 * /biz/season/[season] - Season detail page showing all shows from a specific season
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { seasonOgImage } from '@/lib/biz-og';
import BizHeader from '@/components/biz/BizHeader';
import { notFound } from 'next/navigation';

// Below this many tracked commercial shows a recoup ratio (e.g. 1 of 3) overstates a thin sample.
const MIN_TRACKED_SHOWS = 5;

import { featureFlags } from '@/config/feature-flags';
import {
  getSeasonsWithCommercialData,
  getSeasonStats,
  getShowsBySeasonWithCommercial,
  getSeasonComparison,
  getSeasonProfiles,
  getSeasonPaybackHistory,
  isIndexedCommercialSeason,
} from '@/lib/data-commercial';
import { mixSection, withoutMixRows } from '@/lib/season-findings';
import MixCard from '@/components/biz/MixCard';

import AllShowsTable from '@/components/biz/AllShowsTable';
import MoneyGate from '@/components/biz/MoneyGate';
import SeasonComparisonTable from '@/components/biz/SeasonComparisonTable';
import { formatCapitalSummary } from '@/lib/biz-format';
import { formatSeasonMoney, returnedCapitalText } from '@/lib/season-profile';
import { ESTIMATE_SOURCES_NOTE } from '@/lib/commercial-display';
import EmailTomLink from '@/components/EmailTomLink';

// Dynamically generate params from actual data - auto-updates when shows are added
export function generateStaticParams() {
  const seasons = getSeasonsWithCommercialData();
  return seasons.map((season) => ({
    season,
  }));
}


export async function generateMetadata(props: { params: Promise<{ season: string }> }): Promise<Metadata> {
  const params = await props.params;
  return {
    title: { absolute: `${params.season} Broadway Season | Profitability Scorecard` },
    description: `Commercial data and recoupment metrics for Broadway shows from the ${params.season} season.`,
    alternates: {
      canonical: `${BASE_URL}/biz/season/${params.season}`,
    },
    ...(isIndexedCommercialSeason(params.season) ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      images: [seasonOgImage(params.season)],
      title: `${params.season} Broadway Season`,
      description: `Every Broadway show from the ${params.season} season, sorted from Miracle to Flop: which recouped, which finished in the red, and how much money was at risk.`,
      url: `${BASE_URL}/biz/season/${params.season}`,
    },
  };
}

export default async function SeasonPage(props: { params: Promise<{ season: string }> }) {
  const params = await props.params;
  if (!featureFlags.commercial) notFound();

  const { season } = params;

  // Validate season format
  if (!/^\d{4}-\d{4}$/.test(season)) {
    notFound();
  }

  const stats = getSeasonStats(season);
  const shows = getShowsBySeasonWithCommercial(season);
  const comparison = getSeasonComparison(season);
  const mixCard = mixSection(getSeasonProfiles(), season, comparison);

  // If no shows found, show message
  if (shows.length === 0) {
    return (
      <div className="min-h-screen bg-surface">
        <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
          <Link
            href="/biz"
            className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Profitability Scorecard
          </Link>

          <BizHeader
            title={`${season} Season`}
            tagline="No commercial data available for this season yet."
            sharePath={`/biz/season/${season}`}
            shareTitle={`${season} Broadway Season | Profitability Scorecard`}
          />
        </div>
      </div>
    );
  }

  // Season totals. Unknown capitalizations are counted as undisclosed, never
  // as $0 (BRO-4623 P0-6); nonprofit productions and tour stops are excluded.
  const totalCapital = formatCapitalSummary(stats.totalCapital);
  const capitalAtRisk = formatCapitalSummary(stats.capitalAtRisk);
  // Owner (2026-10-26): the tiles lead with the full estimated total (the
  // Season by Season table's Est. total capital) and with the money in shows
  // that closed without recouping; disclosed-only and still-at-risk sums sit
  // underneath. Same per-show figures as the table (season-profile.ts).
  const profile = getSeasonProfiles().find((p) => p.season === season) ?? null;
  const est = profile && profile.estimatedCapital.total > 0 ? profile.estimatedCapital : null;
  const outcome = profile?.capitalByOutcome ?? null;
  const back = profile ? returnedCapitalText(profile) : null;
  const backHistory = back ? getSeasonPaybackHistory(season) : [];
  const openShows = shows.filter(s => s.status === 'open' || s.status === 'previews').length;
  const closedShows = shows.filter(s => s.status === 'closed').length;

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
        {/* Back Link */}
        <Link
          href="/biz"
          className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Profitability Scorecard
        </Link>

        {/* Header */}
        <BizHeader
          title={`${season} Season`}
          tagline={stats.totalShows >= MIN_TRACKED_SHOWS ? 'Commercial data for all Broadway productions from this season' : 'Commercial data for the Broadway productions we track from this season'}
          sharePath={`/biz/season/${season}`}
          shareTitle={`${season} Broadway Season | Profitability Scorecard`}
        >
          <div className="mt-5 space-y-1">
            <p className="text-xs text-amber-500/70">
              {ESTIMATE_SOURCES_NOTE}{' '}
              <Link href="/methodology#commercial" className="underline hover:text-amber-400">
                How we measure
              </Link>
            </p>
            <p className="text-xs text-amber-500/70">Questions, ideas, requests?{' '}<EmailTomLink className="underline hover:text-amber-400" /></p>
          </div>
        </BizHeader>

        {/* Season Stats Summary. text-xl on phones: "~$164.7M+" overflowed a two-column tile at 360px. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-xl sm:text-2xl font-bold text-white">{shows.length}</div>
            <div className="text-xs text-fg-muted">Total Shows</div>
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            {stats.totalShows >= MIN_TRACKED_SHOWS ? (
              <>
                <div className="text-xl sm:text-2xl font-bold text-emerald-400">
                  {stats.recoupedCount}{' '}
                  <span className="text-sm text-gray-400">of {stats.totalShows}</span>
                </div>
                <div className="text-xs text-fg-muted">Commercial shows recouped</div>
              </>
            ) : (
              <>
                <div className="text-sm text-gray-400">Too few tracked shows to state a recoup rate</div>
                <div className="text-xs text-fg-muted">Commercial shows recouped</div>
              </>
            )}
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-xl sm:text-2xl font-bold text-white">
              {est ? `~${formatSeasonMoney(est.total)}` : totalCapital.value}
            </div>
            <div
              className="text-xs text-fg-muted"
              title="Every commercial production's capitalization: the public figure where there is one, else our estimate (our own budget estimate, or the median of similar shows). Nonprofit productions and tour stops are excluded."
            >
              Total Capital (est.)
            </div>
            {est ? (
              <div className="text-xs text-fg-muted">
                {formatSeasonMoney(profile!.capitalization.all.total)} disclosed{est.estimated > 0 ? `, ${est.estimated} show${est.estimated === 1 ? '' : 's'} estimated` : ''}
              </div>
            ) : (
              totalCapital.note && <div className="text-xs text-fg-muted">{totalCapital.note}</div>
            )}
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            {outcome && outcome.closedUnrecoupedShows > 0 ? (
              <>
                <div className="text-xl sm:text-2xl font-bold text-score-skip">
                  ~{formatSeasonMoney(outcome.closedUnrecouped)}
                </div>
                <div
                  className="text-xs text-fg-muted"
                  title="Capitalization of the closed shows that had not recouped (public figures, else our estimates). Some of it came back to investors; each show's page has our estimate of how much."
                >
                  In closed shows that hadn&apos;t recouped
                </div>
                <div className="text-xs text-fg-muted">
                  {outcome.closedUnrecoupedShows} show{outcome.closedUnrecoupedShows === 1 ? '' : 's'}
                  {outcome.runningShows > 0 && `, plus ~${formatSeasonMoney(outcome.running)} still at risk in ${outcome.runningShows} running show${outcome.runningShows === 1 ? '' : 's'}`}
                </div>
              </>
            ) : (
              <>
                <div className="text-xl sm:text-2xl font-bold text-amber-400">
                  {outcome && outcome.runningShows > 0 ? `~${formatSeasonMoney(outcome.running)}` : capitalAtRisk.value}
                </div>
                <div
                  className="text-xs text-fg-muted"
                  title="Capitalization of shows still running that have not recouped. Nonprofit productions and tour stops are excluded."
                >
                  Still at Risk
                </div>
                <div className="text-xs text-fg-muted">in running shows not yet recouped</div>
              </>
            )}
          </div>
        </div>

        {/* Money back so far (estimate), and how it has grown since we started tracking it (BRO-6335) */}
        {back && profile && (
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5 mb-8" data-testid="season-money-back">
            <div className="text-xl sm:text-2xl font-bold text-emerald-400">{back.headline}</div>
            <div
              className="text-xs text-fg-muted mt-1"
              title="An estimate. Recouped shows count at their reported return, else all of their capital; other shows at an estimate of what has come back (our model from weekly grosses and costs, or an outside estimate). Only shows we can estimate are counted."
            >
              Estimate, {back.range} ({back.share} of the capital in {profile.returnedCapital.shows} shows).{outcome && outcome.runningShows > 0 ? ' It rises as running shows pay back.' : ''}
            </div>
            {backHistory.length > 1 && (
              <div className="text-xs text-fg-muted mt-1">
                Estimate on {backHistory[0].date}: about {formatSeasonMoney(backHistory[0].returnedMid)} back
                {' · '}
                on {backHistory[backHistory.length - 1].date}: about {formatSeasonMoney(backHistory[backHistory.length - 1].returnedMid)} back
              </div>
            )}
          </div>
        )}

        {/* Mix, capital and recoupment vs last season and the 10-season average */}
        {comparison && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-3">
              Compared with {comparison.lastSeason ? 'Last Season and ' : ''}Prior Seasons
            </h2>
            <SeasonComparisonTable comparison={mixCard.columns.length ? withoutMixRows(comparison) : comparison} />
          </section>
        )}

        {mixCard.columns.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-white mb-1">Production Mix</h2>
            <p className="text-sm text-gray-400 mb-3">Originals and revivals, each split into musicals and plays. Counts every Broadway opening, including shows the list below has no investment data for.</p>
            <MixCard columns={mixCard.columns} overallRows={mixCard.overallRows} withinRows={mixCard.withinRows} />
          </section>
        )}

        {/* Show breakdown */}
        {(openShows > 0 || closedShows > 0) && (
          <p className="text-sm text-fg-muted mb-4">
            {openShows > 0 && `${openShows} still running`}
            {openShows > 0 && closedShows > 0 && ' · '}
            {closedShows > 0 && `${closedShows} closed`}
          </p>
        )}

        {/* All Shows Table */}
        <section>
          <MoneyGate page="biz-season">
          <AllShowsTable shows={shows} initialLimit={50} />
          </MoneyGate>
        </section>

        {/* Footer */}
        <footer className="text-sm text-fg-muted border-t border-white/5 pt-6 mt-8">
          <p>
            Capitalization and recoupment from SEC filings and trade press. Weekly box
            office from The Broadway League, as published by Playbill and BroadwayWorld.
            Recoupment estimates are our model.
          </p>
          <div className="flex gap-4 mt-3">
            <Link href="/methodology#commercial" className="text-brand hover:text-brand-hover">
              Methodology →
            </Link>
            <Link href="/feedback" className="text-brand hover:text-brand-hover">
              Report an error →
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
