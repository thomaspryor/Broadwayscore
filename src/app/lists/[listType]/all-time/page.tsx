/**
 * /lists/[listType]/all-time — Gold List all-time page
 * Shows top qualifying shows across all seasons
 *
 * Matches homepage card layout: pills + dates + larger thumbnails + real ScoreBadge
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GOLD_LIST_CONFIGS, GOLD_LIST_MAP, isValidGoldListType, marketFromListType, marketLabelFromListType } from '@/config/gold-lists';
import type { GoldListType } from '@/config/gold-lists';
import {
  getComputedGoldList,
  getSeasonsForList,
} from '@/lib/data-gold-list-badges';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge, getScoreTier } from '@/components/show-cards/ScoreBadge';
import { FormatPill, StatusBadge, ProductionPill } from '@/components/show-cards/ShowPills';
import { generateBreadcrumbSchema, generateItemListSchema, generateGoldListFAQSchema } from '@/lib/seo';
import { SeasonSelect } from '@/components/SeasonSelect';
import { formatGoldListDate, RankBadge, ValueBadge, AudienceGradeBadge } from '@/components/gold-list/GoldListCards';
import { GoldListBadge } from '@/components/gold-list/GoldListBadge';
import Breadcrumb from '@/components/Breadcrumb';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateStaticParams() {
  return GOLD_LIST_CONFIGS.map(c => ({ listType: c.type }));
}

export function generateMetadata({ params }: { params: { listType: string } }): Metadata {
  const config = GOLD_LIST_MAP[params.listType as GoldListType];
  if (!config) return {};

  const title = `${config.title} — All-Time`;
  const market = marketLabelFromListType(params.listType as GoldListType);
  const description = `${config.description}. The top ${config.maxAllTime} ${market} shows of all time.`;

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/lists/${params.listType}/all-time`,
    },
    openGraph: {
      title: `${config.title} — All-Time`,
      description,
      url: `${BASE_URL}/lists/${params.listType}/all-time`,
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary',
      title: `${config.title} — All-Time`,
      description,
    },
  };
}

export default function GoldListAllTimePage({ params }: { params: { listType: string } }) {
  const { listType } = params;

  if (!isValidGoldListType(listType)) {
    notFound();
  }

  const config = GOLD_LIST_MAP[listType as GoldListType];
  const entries = getComputedGoldList(listType, 'all-time');
  const allSeasons = getSeasonsForList(listType);
  const isAudienceList = listType === 'audience-gold';
  const isCriticList = listType === 'critical-gold'
    || listType === 'critical-gold-west-end'
    || listType === 'critical-gold-off-broadway'
    || listType === 'critical-gold-off-west-end';
  const listCategory = marketFromListType(listType as GoldListType);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Gold Lists', url: `${BASE_URL}/lists` },
    { name: config.shortTitle, url: `${BASE_URL}/lists/${listType}/all-time` },
    { name: 'All-Time', url: `${BASE_URL}/lists/${listType}/all-time` },
  ]);

  const itemListSchema = generateItemListSchema(
    entries.map(entry => ({
      name: entry.title,
      url: `${BASE_URL}/show/${entry.slug}`,
      image: entry.thumbnail ? `${BASE_URL}${entry.thumbnail}` : undefined,
      venue: entry.venue,
      startDate: entry.openingDate || undefined,
      endDate: entry.closingDate,
      status: entry.status || undefined,
    })),
    `${config.title} — All-Time`
  );

  return (
    <div className="min-h-screen bg-surface">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema, generateGoldListFAQSchema(config, { entryCount: entries.length, topShow: entries[0]?.title })]) }}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Gold Lists', href: '/lists' },
          { label: `${config.shortTitle} — All-Time` },
        ]} />

        {/* Back Link */}
        <Link href="/lists" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Gold Lists
        </Link>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3 inline-flex items-center gap-2">
            <GoldListBadge type={listType as GoldListType} size="md" />
            <span>{config.title}</span>
          </h1>
          <p className="text-gray-300 leading-relaxed">
            {config.description}
          </p>
          <p className="text-gray-500 text-sm mt-3">
            {entries.length} {entries.length === 1 ? 'show' : 'shows'} across all seasons | All-Time
          </p>
        </div>

        {/* List Type Tabs */}
        <div className="flex overflow-x-auto gap-1 mb-4 pb-1 -mx-1 px-1">
          {GOLD_LIST_CONFIGS.map(c => (
            <Link
              key={c.type}
              href={`/lists/${c.type}/all-time`}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                c.type === listType
                  ? `${c.bgClass} ${c.color} border ${c.borderClass}`
                  : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              <GoldListBadge type={c.type} size="sm" /> {c.shortTitle}
            </Link>
          ))}
        </div>

        {/* Season Selector */}
        <div className="flex items-center gap-2 mb-6">
          <span className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white/10 text-white">
            All-Time
          </span>
          <span className="text-gray-600">|</span>
          <SeasonSelect listType={listType} seasons={allSeasons} currentSeason="" />
        </div>

        {/* Show List */}
        {entries.length > 0 ? (
          <div className="space-y-3 sm:space-y-4">
            {entries.map((entry, index) => (
              <Link
                key={`${entry.showId}-${entry.season}`}
                href={`/show/${entry.slug}`}
                className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
              >
                <RankBadge rank={entry.rank} />

                {/* Thumbnail */}
                <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                  {entry.thumbnail ? (
                    <img
                      src={getOptimizedImageUrl(entry.thumbnail, 'thumbnail')}
                      alt={`${entry.title} ${entry.type || 'show'}`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      width={96}
                      height={96}
                      loading={index < 4 ? 'eager' : 'lazy'}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-2xl">🎭</span>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-white text-base sm:text-xl group-hover:text-brand transition-colors truncate">
                    {entry.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {entry.type && <FormatPill type={entry.type} />}
                    {entry.isRevival !== undefined && <ProductionPill isRevival={entry.isRevival} />}
                    {entry.status && <StatusBadge status={entry.status} />}
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5 truncate">
                    {entry.openingDate ? (
                      <>
                        {entry.status === 'closed' && entry.closingDate ? (
                          <>
                            <span className="text-gray-500">Closed {formatGoldListDate(entry.closingDate)}</span>
                            <span className="text-gray-500"> · Opened {formatGoldListDate(entry.openingDate)}</span>
                          </>
                        ) : (
                          <>Opened {formatGoldListDate(entry.openingDate)}</>
                        )}
                        <span className="text-gray-500"> · {entry.season}</span>
                      </>
                    ) : (
                      <span className="text-gray-500">{entry.venue} · {entry.season}</span>
                    )}
                  </p>
                </div>

                {/* Score/Value */}
                {isCriticList ? (
                  <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                    {(() => { const tier = getScoreTier(entry.value, listCategory); return tier ? (
                      <span className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                        style={{ color: tier.color }}>{tier.label}</span>
                    ) : null; })()}
                    <ScoreBadge score={entry.value} size="lg" showCrown status={entry.status || undefined} category={listCategory} />
                  </div>
                ) : isAudienceList ? (
                  <AudienceGradeBadge score={entry.value} />
                ) : (
                  <ValueBadge displayValue={entry.displayValue} label={config.metricLabel} />
                )}
              </Link>
            ))}
          </div>
        ) : (
          <div className="card p-6 sm:p-8 text-center">
            <div className="text-3xl sm:text-4xl mb-4">🎭</div>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2">No Shows Qualify</h2>
            <p className="text-gray-400 text-sm sm:text-base">
              {listType === 'hot-ticket-gold'
                ? 'Capacity data is limited. More seasons will be added as data becomes available.'
                : 'No shows met the minimum threshold across all seasons.'}
            </p>
          </div>
        )}

        {/* Footer */}
        <footer className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-8">
          <p>
            <strong className="text-gray-400">Methodology:</strong> {config.minDataRequirement}.
            {config.threshold > 0 && ` Minimum ${config.metricLabel.toLowerCase()}: ${config.threshold}${config.metricSuffix}.`}
            {' '}Top {config.maxAllTime} across all seasons since 2005.
          </p>
        </footer>
      </div>
    </div>
  );
}
