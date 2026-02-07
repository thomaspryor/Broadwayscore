/**
 * /lists — Gold Lists index page
 * Shows all 4 list types as cards with links to current season + all-time
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { GOLD_LIST_CONFIGS } from '@/config/gold-lists';
import { getGoldListSeasons } from '@/lib/data-gold-list-badges';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Gold Lists | Broadway Scorecard',
  description: 'Curated rankings of the best Broadway shows by critics, audiences, box office, and demand. Updated each season.',
  alternates: {
    canonical: `${BASE_URL}/lists`,
  },
  openGraph: {
    title: 'Broadway Gold Lists',
    description: 'Curated rankings of the best Broadway shows by critics, audiences, box office, and demand.',
    url: `${BASE_URL}/lists`,
  },
};

export default function GoldListsIndex() {
  const seasons = getGoldListSeasons();
  const currentSeason = seasons[0] || '2024-2025';

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-white transition-colors">Home</Link>
            </li>
            <li className="text-gray-500">/</li>
            <li className="text-gray-300">Gold Lists</li>
          </ol>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Broadway Gold Lists
          </h1>
          <p className="text-gray-300 leading-relaxed">
            The best of Broadway, ranked. Four curated lists highlighting the top shows
            each season — by critical acclaim, audience love, box office power, and ticket demand.
          </p>
        </div>

        {/* List Type Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          {GOLD_LIST_CONFIGS.map(config => (
            <div
              key={config.type}
              className={`${config.bgClass} border ${config.borderClass} rounded-xl p-5 sm:p-6`}
            >
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">{config.icon}</span>
                <div>
                  <h2 className={`text-lg font-bold ${config.color}`}>
                    {config.title}
                  </h2>
                  <p className="text-gray-400 text-sm mt-1">
                    {config.description}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                <Link
                  href={`/lists/${config.type}/${currentSeason}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-gray-300 hover:text-white transition-colors"
                >
                  {currentSeason}
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
                <Link
                  href={`/lists/${config.type}/all-time`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-gray-300 hover:text-white transition-colors"
                >
                  All-Time
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* Season Navigation */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">Browse by Season</h2>
          <div className="flex flex-wrap gap-2">
            {seasons.slice(0, 10).map(season => (
              <Link
                key={season}
                href={`/lists/critical-gold/${season}`}
                className="px-3 py-1.5 rounded-lg bg-surface-overlay border border-white/5 text-sm text-gray-300 hover:text-white hover:border-white/15 transition-colors"
              >
                {season}
              </Link>
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-8">
          <p>
            Gold Lists are curated each season with minimum quality thresholds.
            Shows must meet review count and score minimums to qualify — not every season has 10 shows per list.
          </p>
        </footer>
      </div>
    </div>
  );
}
