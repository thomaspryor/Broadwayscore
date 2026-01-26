import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getShowGrosses, getGrossesWeekEnding, getGrossesLastUpdated } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Broadway Box Office - Weekly Grosses & All-Time Stats',
  description: 'Complete Broadway box office data: weekly grosses, capacity percentages, average ticket prices, and all-time statistics for every show currently playing.',
  alternates: {
    canonical: `${BASE_URL}/box-office`,
  },
  openGraph: {
    title: 'Broadway Box Office Leaderboard',
    description: 'Weekly grosses, capacity, and all-time box office stats for every Broadway show.',
    url: `${BASE_URL}/box-office`,
    type: 'article',
  },
};

// FAQ Schema for AI optimization
const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the highest-grossing Broadway show this week?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The highest-grossing Broadway shows typically include long-running hits like Wicked, The Lion King, and Hamilton, which regularly gross over $2 million per week. Check our weekly updated leaderboard for current rankings.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the highest-grossing Broadway show of all time?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The Lion King is the highest-grossing Broadway show of all time, having earned over $2 billion on Broadway alone since opening in 1997. Wicked and Hamilton are also among the top grossers.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where does Broadway box office data come from?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Broadway box office data is reported weekly by The Broadway League and published by outlets like BroadwayWorld. Data is typically released on Mondays or Tuesdays for the week ending the previous Sunday.',
      },
    },
  ],
};

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  if (amount >= 1000000000) {
    return `$${(amount / 1000000000).toFixed(1)}B`;
  }
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(0)}K`;
  }
  return `$${amount.toLocaleString()}`;
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '—';
  return num.toLocaleString();
}

function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '—';
  return `${pct.toFixed(1)}%`;
}

function ChangeIndicator({ current, previous }: { current: number | null | undefined; previous: number | null | undefined }) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.1) return null;

  const isPositive = change > 0;
  return (
    <span className={`text-xs ml-1 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? '↑' : '↓'}{Math.abs(change).toFixed(1)}%
    </span>
  );
}

export default function BoxOfficePage() {
  const allShows = getAllShows();
  const weekEnding = getGrossesWeekEnding();
  const lastUpdated = getGrossesLastUpdated();

  // Get shows with grosses data, sorted by this week's gross
  const showsWithGrosses = allShows
    .filter(show => show.status === 'open')
    .map(show => ({
      show,
      grosses: getShowGrosses(show.slug),
    }))
    .filter(item => item.grosses?.thisWeek?.gross)
    .sort((a, b) => (b.grosses?.thisWeek?.gross || 0) - (a.grosses?.thisWeek?.gross || 0));

  // Get all-time leaders (including closed shows)
  const allTimeLeaders = allShows
    .map(show => ({
      show,
      grosses: getShowGrosses(show.slug),
    }))
    .filter(item => item.grosses?.allTime?.gross)
    .sort((a, b) => (b.grosses?.allTime?.gross || 0) - (a.grosses?.allTime?.gross || 0))
    .slice(0, 10);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Box Office', url: `${BASE_URL}/box-office` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Box Office</h1>
          <p className="text-gray-400 mt-2">
            Weekly grosses and all-time statistics for every Broadway show.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            Week ending {weekEnding} · Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* This Week Leaderboard */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">This Week&apos;s Top Grossers</h2>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-surface-overlay">
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Show</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium">Gross</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Capacity</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium hidden md:table-cell">Avg Ticket</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Attendance</th>
                  </tr>
                </thead>
                <tbody>
                  {showsWithGrosses.map((item, index) => (
                    <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                          index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                        }`}>
                          {index + 1}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                          {item.show.title}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-right text-white font-medium">
                        {formatCurrency(item.grosses?.thisWeek?.gross)}
                        <ChangeIndicator
                          current={item.grosses?.thisWeek?.gross}
                          previous={item.grosses?.thisWeek?.grossPrevWeek}
                        />
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 hidden sm:table-cell">
                        {formatPercent(item.grosses?.thisWeek?.capacity)}
                        <ChangeIndicator
                          current={item.grosses?.thisWeek?.capacity}
                          previous={item.grosses?.thisWeek?.capacityPrevWeek}
                        />
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 hidden md:table-cell">
                        {item.grosses?.thisWeek?.atp ? `$${item.grosses.thisWeek.atp.toFixed(0)}` : '—'}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 hidden lg:table-cell">
                        {formatNumber(item.grosses?.thisWeek?.attendance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* All-Time Leaders */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">All-Time Box Office Leaders</h2>
          <p className="text-gray-400 text-sm mb-4">
            Cumulative Broadway gross over entire run. The Lion King holds the all-time record at over $2 billion.
          </p>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-surface-overlay">
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Show</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium">Total Gross</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Performances</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium hidden md:table-cell">Attendance</th>
                    <th className="text-center py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {allTimeLeaders.map((item, index) => (
                    <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                          index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                        }`}>
                          {index + 1}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                          {item.show.title}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-right text-white font-medium">
                        {formatCurrency(item.grosses?.allTime?.gross)}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 hidden sm:table-cell">
                        {formatNumber(item.grosses?.allTime?.performances)}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 hidden md:table-cell">
                        {formatNumber(item.grosses?.allTime?.attendance)}
                      </td>
                      <td className="py-3 px-4 text-center hidden lg:table-cell">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          item.show.status === 'open'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-gray-500/15 text-gray-400'
                        }`}>
                          {item.show.status === 'open' ? 'Running' : 'Closed'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Box office data sourced from BroadwayWorld, which aggregates official figures from The Broadway League.
            Updated weekly after the reporting period ends.
          </p>
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
            Learn more about our data sources →
          </Link>
        </div>
      </div>
    </>
  );
}
