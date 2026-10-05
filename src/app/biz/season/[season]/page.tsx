/**
 * /biz/season/[season] - Season detail page showing all shows from a specific season
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { featureFlags } from '@/config/feature-flags';
import {
  getSeasonsWithCommercialData,
  getSeasonStats,
  getShowsBySeasonWithCommercial,
} from '@/lib/data-commercial';

import AllShowsTable from '@/components/biz/AllShowsTable';
import { formatCapitalSummary } from '@/lib/biz-format';

// Dynamically generate params from actual data - auto-updates when shows are added
export function generateStaticParams() {
  const seasons = getSeasonsWithCommercialData();
  return seasons.map((season) => ({
    season,
  }));
}

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateMetadata({ params }: { params: { season: string } }): Metadata {
  return {
    title: `${params.season} Broadway Season | Investment Tracker`,
    description: `Commercial data and recoupment metrics for Broadway shows from the ${params.season} season.`,
    alternates: {
      canonical: `${BASE_URL}/biz/season/${params.season}`,
    },
    openGraph: {
      title: `${params.season} Broadway Season`,
      description: `Commercial data and recoupment metrics for the ${params.season} Broadway season.`,
      url: `${BASE_URL}/biz/season/${params.season}`,
    },
  };
}

export default function SeasonPage({ params }: { params: { season: string } }) {
  if (!featureFlags.commercial) notFound();

  const { season } = params;

  // Validate season format
  if (!/^\d{4}-\d{4}$/.test(season)) {
    notFound();
  }

  const stats = getSeasonStats(season);
  const shows = getShowsBySeasonWithCommercial(season);

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
            Investment Tracker
          </Link>

          <h1 className="text-3xl font-bold text-white mb-4">{season} Season</h1>
          <p className="text-gray-400">No commercial data available for this season yet.</p>
        </div>
      </div>
    );
  }

  // Season totals. Unknown capitalizations are counted as undisclosed, never
  // as $0 (BRO-4623 P0-6); nonprofit productions and tour stops are excluded.
  const totalCapital = formatCapitalSummary(stats.totalCapital);
  const capitalAtRisk = formatCapitalSummary(stats.capitalAtRisk);
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
          Investment Tracker
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            {season} Season
          </h1>
          <p className="text-gray-400 mt-2">
            Commercial data for all Broadway productions from this season
          </p>
          <p className="text-xs text-amber-500/70 mt-1">
            ~ marks an estimate.{' '}
            <Link href="/methodology#commercial" className="underline hover:text-amber-400">
              How we measure
            </Link>
          </p>
        </div>

        {/* Season Stats Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-2xl font-bold text-white">{shows.length}</div>
            <div className="text-xs text-gray-500">Total Shows</div>
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-2xl font-bold text-emerald-400">
              {stats.recoupedCount}{' '}
              <span className="text-sm text-gray-400">of {stats.totalShows}</span>
            </div>
            <div className="text-xs text-gray-500">Commercial shows recouped</div>
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-2xl font-bold text-white">
              {totalCapital.value}
            </div>
            <div
              className="text-xs text-gray-500"
              title="Sum of known capitalizations for commercial productions. Nonprofit productions and tour stops are excluded."
            >
              Total Capital
            </div>
            {totalCapital.note && <div className="text-xs text-gray-500">{totalCapital.note}</div>}
          </div>
          <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
            <div className="text-2xl font-bold text-amber-400">
              {capitalAtRisk.value}
            </div>
            <div
              className="text-xs text-gray-500"
              title="Capitalization of shows still running that have not recouped. Nonprofit productions and tour stops are excluded."
            >
              Capital at Risk
            </div>
            {capitalAtRisk.note && <div className="text-xs text-gray-500">{capitalAtRisk.note}</div>}
          </div>
        </div>

        {/* Show breakdown */}
        {(openShows > 0 || closedShows > 0) && (
          <p className="text-sm text-gray-500 mb-4">
            {openShows > 0 && `${openShows} still running`}
            {openShows > 0 && closedShows > 0 && ' · '}
            {closedShows > 0 && `${closedShows} closed`}
          </p>
        )}

        {/* All Shows Table */}
        <section>
          <AllShowsTable shows={shows} initialLimit={50} />
        </section>

        {/* Footer */}
        <footer className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-8">
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
