import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getShowGrosses, getGrossesWeekEnding, getGrossesLastUpdated } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { ThisWeekTable, AllTimeTable } from '@/components/SortableBoxOfficeTable';

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
          <p className="text-gray-400 text-sm mb-4">
            Click any column header to sort. Shows are ranked by weekly gross by default.
          </p>
          <ThisWeekTable data={showsWithGrosses} />
        </section>

        {/* All-Time Leaders */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4">All-Time Box Office Leaders</h2>
          <p className="text-gray-400 text-sm mb-4">
            Cumulative Broadway gross over entire run. The Lion King holds the all-time record at over $2 billion.
          </p>
          <AllTimeTable data={allTimeLeaders} />
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
