/**
 * /lists/[listType]/all-time — Gold List all-time page
 * Shows top 25 qualifying shows across all seasons
 *
 * Matches homepage card layout: pills + dates + larger thumbnails + real ScoreBadge
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GOLD_LIST_CONFIGS, GOLD_LIST_MAP, GOLD_LIST_TYPES, isValidGoldListType } from '@/config/gold-lists';
import type { GoldListType } from '@/config/gold-lists';
import {
  getComputedGoldList,
  getSeasonsForList,
} from '@/lib/data-gold-list-badges';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge } from '@/components/show-cards/ScoreBadge';
import { FormatPill, StatusBadge, ProductionPill } from '@/components/show-cards/ShowPills';
import { getAudienceGrade } from '@/lib/data-audience';
import { SeasonSelect } from '@/components/SeasonSelect';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function generateStaticParams() {
  return GOLD_LIST_TYPES.map(listType => ({ listType }));
}

export function generateMetadata({ params }: { params: { listType: string } }): Metadata {
  const config = GOLD_LIST_MAP[params.listType as GoldListType];
  if (!config) return {};

  const title = `${config.title} — All-Time | Broadway Scorecard`;
  const description = `${config.description}. The top ${config.maxAllTime} Broadway shows of all time.`;

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
    },
  };
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

function ValueBadge({ displayValue, label }: { displayValue: string; label: string }) {
  return (
    <div className="flex-shrink-0 text-right">
      <div className="px-2 py-1.5 sm:px-3 sm:py-2 bg-surface-overlay border border-white/10 rounded-lg sm:rounded-xl text-center min-w-[56px]">
        <div className="text-white font-bold text-xs sm:text-sm leading-tight">{displayValue}</div>
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5 text-center">{label}</div>
    </div>
  );
}

function AudienceGradeBadge({ score }: { score: number }) {
  const grade = getAudienceGrade(score);
  return (
    <div className="flex-shrink-0 flex flex-col items-center gap-0.5">
      <div
        className={`score-badge w-11 h-11 text-lg rounded-lg font-bold${grade.grade === 'A+' ? ' audience-top-grade' : ''}`}
        style={grade.grade === 'A+' ? {} : {
          backgroundColor: grade.color,
          color: grade.textColor,
          boxShadow: `0 2px 8px ${grade.color}4d`,
        }}
        title={grade.tooltip}
      >
        {grade.grade}
      </div>
      <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: grade.color }}>
        {grade.label}
      </span>
    </div>
  );
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
  const isCriticList = listType === 'critical-gold';

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-white transition-colors">Home</Link>
            </li>
            <li className="text-gray-500">/</li>
            <li>
              <Link href="/lists" className="hover:text-white transition-colors">Gold Lists</Link>
            </li>
            <li className="text-gray-500">/</li>
            <li className="text-gray-300">{config.shortTitle} — All-Time</li>
          </ol>
        </nav>

        {/* Back Link */}
        <Link href="/lists" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Gold Lists
        </Link>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            {config.icon} {config.title}
          </h1>
          <p className="text-gray-300 leading-relaxed">
            {config.description}
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Top {config.maxAllTime} across all seasons | All-Time
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
              {c.icon} {c.shortTitle}
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
                      alt={`${entry.title} Broadway ${entry.type || 'show'}`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
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
                  <h2 className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors truncate">
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
                            <span className="text-gray-500">Closed {formatDate(entry.closingDate)}</span>
                            <span className="text-gray-500"> · Opened {formatDate(entry.openingDate)}</span>
                          </>
                        ) : (
                          <>Opened {formatDate(entry.openingDate)}</>
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
                  <ScoreBadge score={entry.value} size="lg" status={entry.status || undefined} />
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
