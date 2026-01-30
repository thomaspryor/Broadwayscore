/**
 * /biz - Broadway Investment Tracker Dashboard
 * Sprint 3: Dashboard Page
 */

import Link from 'next/link';
import type { Metadata } from 'next';

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
} from '@/lib/data';

import SeasonStatsCard from '@/components/biz/SeasonStatsCard';
import RecentDevelopmentsList, { type DevelopmentItem } from '@/components/biz/RecentDevelopmentsList';
import ApproachingRecoupmentCard from '@/components/biz/ApproachingRecoupmentCard';
import AtRiskCard from '@/components/biz/AtRiskCard';
import RecoupmentTable from '@/components/biz/RecoupmentTable';
import AllShowsTable from '@/components/biz/AllShowsTable';
import DesignationLegend from '@/components/biz/DesignationLegend';
import GatedDownloadButtons from '@/components/biz/GatedDownloadButtons';
import BizPageTracker from '@/components/biz/BizPageTracker';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Investment Tracker | Broadway Scorecard',
  description:
    'Recoupment data and investment metrics for Broadway shows. Track which shows have recouped, capital at risk, and financial trends.',
  alternates: {
    canonical: `${BASE_URL}/biz`,
  },
  openGraph: {
    title: 'Broadway Investment Tracker',
    description: 'Recoupment data and investment metrics for industry insiders',
    url: `${BASE_URL}/biz`,
  },
};

// Format date as "Mon YYYY" or "Mon DD"
function formatDateShort(dateStr: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Handle YYYY-MM format (recoup dates)
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const [year, month] = dateStr.split('-');
    return `${months[parseInt(month) - 1]} ${year}`;
  }

  // Handle YYYY-MM-DD format (closing dates)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const date = new Date(dateStr);
    const now = new Date();
    // If within current year, show "Mon DD"
    if (date.getFullYear() === now.getFullYear()) {
      return `${months[date.getMonth()]} ${date.getDate()}`;
    }
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  return dateStr;
}

// Generate recent developments from actual data
function generateRecentDevelopments(): DevelopmentItem[] {
  const items: DevelopmentItem[] = [];

  // Add recent recoupments (last 12 months)
  const recentRecoupments = getRecentRecoupments(12);
  for (const show of recentRecoupments.slice(0, 4)) {
    items.push({
      date: formatDateShort(show.recoupDate),
      type: 'recouped',
      showTitle: show.title,
      showSlug: show.slug,
      description: `recouped in ~${show.weeksToRecoup} weeks`,
    });
  }

  // Add recent closings that didn't recoup (last 3 months)
  const recentClosings = getRecentClosings(3);
  for (const show of recentClosings.slice(0, 3)) {
    const desc = show.designation === 'Flop'
      ? 'closed as a flop'
      : show.designation === 'Fizzle'
        ? 'closed without recouping'
        : 'closed';
    items.push({
      date: formatDateShort(show.closingDate),
      type: 'closing',
      showTitle: show.title,
      showSlug: show.slug,
      description: desc,
    });
  }

  // Add upcoming closings (announced)
  const upcomingClosings = getUpcomingClosings();
  for (const show of upcomingClosings.slice(0, 2)) {
    items.push({
      date: formatDateShort(show.closingDate),
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
      description: 'below break-even',
    });
  }

  // Sort by type priority: recouped first, then closings, then at-risk
  // Within same type, most recent first (already sorted by date from data functions)
  return items.slice(0, 8);
}

export default function BizDashboard() {
  // Get data for all sections
  // Dynamically get seasons with commercial data (most recent first)
  const allSeasons = getSeasonsWithCommercialData();
  // Show up to 4 most recent seasons
  const displaySeasons = allSeasons.slice(0, 4);
  const seasonStats = displaySeasons.map(season => getSeasonStats(season));

  const approachingRecoupment = getShowsApproachingRecoupment();
  const atRiskShows = getShowsAtRisk();
  const recentRecoupments = getRecentRecoupments(24);
  const allOpenShows = getAllOpenShowsWithCommercial();

  const recentDevelopments = generateRecentDevelopments();
  const lastUpdated = getCommercialLastUpdated();

  const bizFaqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'What does it mean for a Broadway show to recoup?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Recoupment means a Broadway show has earned back its initial investment (capitalization) through ticket sales and other revenue. A show that has recouped is profitable for its investors. Most Broadway shows fail to recoup — only about 25% of shows earn back their investment.',
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(bizFaqSchema) }}
      />
    <div className="min-h-screen bg-surface">
      {/* Track page views for gating */}
      <BizPageTracker page="biz-dashboard" />
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
            <GatedDownloadButtons />
          </div>
        </div>

        {/* Season Stats Row */}
        <section className="mb-8">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            By Season
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {seasonStats.map((stats) => (
              <SeasonStatsCard key={stats.season} {...stats} />
            ))}
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
    </>
  );
}
