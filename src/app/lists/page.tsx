/**
 * /lists — Gold Lists index page
 * Shows all 4 list types as cards with links to current season + all-time
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { GOLD_LIST_CONFIGS, marketLabelFromListType } from '@/config/gold-lists';
import { getGoldListSeasons, getSeasonsForList } from '@/lib/data-gold-list-badges';
import { GoldListBadge } from '@/components/gold-list/GoldListBadge';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

export const metadata: Metadata = {
  title: 'Gold Lists — Broadway & West End',
  description: 'Curated rankings of the best Broadway and West End shows by critics, audiences, box office, and demand. Updated each season.',
  alternates: {
    canonical: `${BASE_URL}/lists`,
  },
  openGraph: {
    title: 'Gold Lists — Broadway & West End',
    description: 'Curated rankings of the best Broadway and West End shows by critics, audiences, box office, and demand.',
    url: `${BASE_URL}/lists`,
  },
};

export default function GoldListsIndex() {
  const seasons = getGoldListSeasons();
  const currentSeason = seasons[0] || '2024-2025';

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Gold Lists', url: `${BASE_URL}/lists` },
  ]);

  return (
    <>
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
    />
    <div className="min-h-screen bg-surface">
      <div className="max-w-4xl mx-auto px-4 py-6 sm:py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Gold Lists' },
        ]} />

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Gold Lists™
          </h1>
          <p className="text-gray-300 leading-relaxed">
            The best of Broadway and the West End, ranked. Curated lists highlighting the top shows
            each season — by critical acclaim, audience love, box office power, and ticket demand.
          </p>
        </div>

        {/* List Type Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          {GOLD_LIST_CONFIGS.map(config => {
            // Per-list latest season with data — Off-Broadway/Off-West End may not have
            // 2024-2025 entries even when the Broadway list does, so link each card to
            // its own most-recent non-empty season rather than a global currentSeason.
            const listSeasons = getSeasonsForList(config.type);
            const latestSeason = listSeasons[0]; // sorted descending in data-gold-list-badges
            const marketLabel = marketLabelFromListType(config.type);
            // Only critic lists get a market label — audience/box-office/hot-ticket are Broadway-only.
            const showMarketLabel = config.type.startsWith('critical-gold');
            return (
              <div
                key={config.type}
                className={`${config.bgClass} border ${config.borderClass} rounded-xl p-5 sm:p-6`}
              >
                <div className="flex items-start gap-3 mb-3">
                  <GoldListBadge type={config.type} size="md" />
                  <div>
                    <h2 className={`text-lg font-bold ${config.color}`}>
                      {config.title}
                    </h2>
                    {showMarketLabel && (
                      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-0.5">
                        {marketLabel}
                      </div>
                    )}
                    <p className="text-gray-400 text-sm mt-1">
                      {config.description}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
                  {latestSeason && (
                    <Link
                      href={`/lists/${config.type}/${latestSeason}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-gray-300 hover:text-white transition-colors"
                    >
                      {latestSeason}
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  )}
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
            );
          })}
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
            Gold Lists™ are curated each season with minimum quality thresholds.
            Shows must meet review count and score minimums to qualify — not every season has 10 shows per list.
          </p>
        </footer>
      </div>
    </div>
    </>
  );
}
