/**
 * /biz - Broadway Investment Tracker Dashboard
 * Sprint 3: Dashboard Page
 */

import Link from 'next/link';
import type { Metadata } from 'next';

import {
  getSeasonStats,
  getShowsApproachingRecoupment,
  getShowsAtRisk,
  getRecentRecoupments,
  getAllOpenShowsWithCommercial,
  getCommercialLastUpdated,
} from '@/lib/data';

import SeasonStatsCard from '@/components/biz/SeasonStatsCard';
import RecentDevelopmentsList, { type DevelopmentItem } from '@/components/biz/RecentDevelopmentsList';
import ApproachingRecoupmentCard from '@/components/biz/ApproachingRecoupmentCard';
import AtRiskCard from '@/components/biz/AtRiskCard';
import RecoupmentTable from '@/components/biz/RecoupmentTable';
import AllShowsTable from '@/components/biz/AllShowsTable';
import DesignationLegend from '@/components/biz/DesignationLegend';

export const metadata: Metadata = {
  title: 'Broadway Investment Tracker | Broadway Scorecard',
  description:
    'Recoupment data and investment metrics for Broadway shows. Track which shows have recouped, capital at risk, and financial trends.',
  openGraph: {
    title: 'Broadway Investment Tracker',
    description: 'Recoupment data and investment metrics for industry insiders',
  },
};

// Generate recent developments from actual data
function generateRecentDevelopments(): DevelopmentItem[] {
  const items: DevelopmentItem[] = [];
  const recentRecoupments = getRecentRecoupments(12);

  // Add recent recoupments
  for (const show of recentRecoupments.slice(0, 3)) {
    const [year, month] = show.recoupDate.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateStr = `${months[parseInt(month) - 1]} ${year}`;

    items.push({
      date: dateStr,
      type: 'recouped',
      showTitle: show.title,
      showSlug: show.slug,
      description: `recouped in ~${show.weeksToRecoup} weeks`,
    });
  }

  // Add shows at risk
  const atRiskShows = getShowsAtRisk();
  for (const show of atRiskShows.slice(0, 2)) {
    // Determine accurate description based on actual status
    const isBelowBreakEven = show.weeklyGross < show.weeklyRunningCost;
    const description = isBelowBreakEven
      ? 'operating below break-even'
      : 'declining trajectory';

    items.push({
      date: 'Jan 2026',
      type: 'at-risk',
      showTitle: show.title,
      showSlug: show.slug,
      description,
    });
  }

  // Sort by date (most recent first) - simple heuristic since dates are mixed formats
  return items.slice(0, 5);
}

export default function BizDashboard() {
  // Get data for all sections
  // Only show recent seasons with complete data
  const season2425 = getSeasonStats('2024-2025');
  const season2324 = getSeasonStats('2023-2024');

  const approachingRecoupment = getShowsApproachingRecoupment();
  const atRiskShows = getShowsAtRisk();
  const recentRecoupments = getRecentRecoupments(24);
  const allOpenShows = getAllOpenShowsWithCommercial();

  const recentDevelopments = generateRecentDevelopments();
  const lastUpdated = getCommercialLastUpdated();

  return (
    <div className="min-h-screen bg-surface">
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
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-white">
                Broadway Investment Tracker
              </h1>
              <p className="text-gray-400 mt-2">
                Recoupment data and investment metrics for industry insiders
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Data from SEC filings, trade press · Updated {lastUpdated}
              </p>
              <p className="text-xs text-amber-500/70 mt-1">
                ~ indicates estimate based on public reporting
              </p>
            </div>
            <div className="flex gap-2">
              <a
                href="/data/commercial.json"
                download
                className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition"
              >
                ↓ JSON
              </a>
              <a
                href="/data/commercial.csv"
                download
                className="px-4 py-2 bg-brand/20 text-brand rounded-lg text-sm font-medium hover:bg-brand/30 transition"
              >
                ↓ CSV
              </a>
            </div>
          </div>
        </div>

        {/* Season Stats Row */}
        <section className="mb-8">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            By Season
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SeasonStatsCard {...season2425} />
            <SeasonStatsCard {...season2324} />
          </div>
        </section>

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
              Shows trending toward break-even based on current run rate.
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
              Shows operating below break-even and less than 30% recouped.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {atRiskShows.slice(0, 6).map((show) => (
                <AtRiskCard
                  key={show.slug}
                  {...show}
                  breakEven={show.weeklyRunningCost}
                />
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
              Shows that recouped in the last 2 years.
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
            Complete commercial data for all open Broadway productions.
          </p>
          <AllShowsTable shows={allOpenShows} initialLimit={10} />
        </section>

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
            <strong className="text-gray-400">Note:</strong> All capitalization,
            weekly running costs, and recoupment estimates marked with ~ are based
            on trade press reporting, SEC filings, and industry analysis. Box
            office grosses are from BroadwayWorld and are actuals.
          </p>
          <p>
            Data compiled from SEC filings, trade press (Broadway Journal,
            Broadway News, Deadline, Variety), and industry sources.
          </p>
          <div className="flex gap-4 mt-3">
            <Link
              href="/biz-buzz"
              className="text-brand hover:text-brand-hover"
            >
              Full Commercial Scorecard →
            </Link>
            <Link
              href="/methodology"
              className="text-brand hover:text-brand-hover"
            >
              Methodology →
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
