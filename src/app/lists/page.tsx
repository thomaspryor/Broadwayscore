/**
 * /lists — Gold Lists index page
 * Organized by market (New York / London) → venue tier → list types
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import {
  GOLD_LIST_MAP,
  getVenueTiersForMarket,
  getListTypesForVenueTier,
  venueTierLabel,
  marketLabel,
} from '@/config/gold-lists';
import type { GoldListMarket, VenueTier } from '@/config/gold-lists';
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

const MARKETS: GoldListMarket[] = ['new-york', 'london'];

function VenueTierSection({ tier }: { tier: VenueTier }) {
  const listTypes = getListTypesForVenueTier(tier);

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
        {venueTierLabel(tier)}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {listTypes.map(lt => {
          const config = GOLD_LIST_MAP[lt];
          const listSeasons = getSeasonsForList(lt);
          const latestSeason = listSeasons[0];
          return (
            <div
              key={lt}
              className={`${config.bgClass} border ${config.borderClass} rounded-xl p-4 sm:p-5`}
            >
              <div className="flex items-start gap-3 mb-3">
                <GoldListBadge type={lt} size="md" />
                <div>
                  <h4 className={`text-base font-bold ${config.color}`}>
                    {config.title}
                  </h4>
                  <p className="text-gray-400 text-sm mt-1">
                    {config.description}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {latestSeason && (
                  <Link
                    href={`/lists/${lt}/${latestSeason}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    {latestSeason}
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                )}
                <Link
                  href={`/lists/${lt}/all-time`}
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
    </div>
  );
}

export default function GoldListsIndex() {
  const seasons = getGoldListSeasons();

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

        {/* Market sections */}
        {MARKETS.map(market => {
          const tiers = getVenueTiersForMarket(market);
          return (
            <section key={market} className="mb-10">
              <h2 className="text-xl sm:text-2xl font-bold text-white mb-5">
                {marketLabel(market)}
              </h2>
              <div className="space-y-6">
                {tiers.map(tier => (
                  <VenueTierSection key={tier} tier={tier} />
                ))}
              </div>
            </section>
          );
        })}

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
