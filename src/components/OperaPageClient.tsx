'use client';

import { useState, useMemo, useCallback, startTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ShowListCard, MiniShowCard, ToggleBar, SCORE_TIERS } from '@/components/show-cards';
import type { ShowCardShow, ScoreModeParam } from '@/components/show-cards/types';
import { hasEnoughReviews } from '@/config/score-buckets';
import { getNextSort, getSortArrow, normalizeSort } from '@/lib/sort-toggle';

export interface OperaPageClientProps {
  shows: ShowCardShow[];
  totalShows: number;
  totalReviews: number;
}

type StatusParam = 'now_playing' | 'closed' | 'all';
type SortParam = 'recent' | 'recent_asc' | 'score_desc' | 'score_asc' | 'alpha' | 'alpha_desc';
const SORT_PARAMS: SortParam[] = ['recent', 'recent_asc', 'score_desc', 'score_asc', 'alpha', 'alpha_desc'];

const DEFAULT_STATUS: StatusParam = 'all';
const DEFAULT_SORT: SortParam = 'recent';

const statusParamToFilter: Record<StatusParam, string> = {
  now_playing: 'open',
  closed: 'closed',
  all: 'all',
};

function operaTitleSlug(fullSlug: string): string {
  return fullSlug.replace(/-off-broadway/, '');
}

function operaHasEnoughReviews(show: ShowCardShow): boolean {
  const rc = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(rc, 'off-broadway', t1t2);
}

function OperaPageInner({ shows, totalShows, totalReviews }: OperaPageClientProps) {
  const initialSearchParams = useSearchParams();

  const [filters, setFilters] = useState(() => ({
    status: (['now_playing', 'closed', 'all'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (SORT_PARAMS.includes(initialSearchParams.get('sort') as SortParam)
      ? initialSearchParams.get('sort') as SortParam : DEFAULT_SORT),
  }));

  const status = filters.status;
  const sort = filters.sort;
  const statusFilter = statusParamToFilter[status];
  const scoreMode: ScoreModeParam = 'critics';

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    startTransition(() => setFilters(prev => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          (next as Record<string, string>)[key] =
            key === 'status' ? DEFAULT_STATUS : DEFAULT_SORT;
        } else {
          (next as Record<string, string>)[key] = value;
        }
      }

      const urlParams = new URLSearchParams(window.location.search);
      const setOrDelete = (key: string, value: string, isDefault: boolean) => {
        if (isDefault) urlParams.delete(key);
        else urlParams.set(key, value);
      };
      setOrDelete('status', next.status, next.status === DEFAULT_STATUS);
      setOrDelete('sort', next.sort, next.sort === DEFAULT_SORT);

      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/opera?${paramString}` : '/opera');

      return next;
    }));
  }, []);

  // Upcoming shelf: shows not yet open, sorted by openingDate ascending
  const upcomingShows = useMemo(
    () => shows
      .filter(s => s.status === 'upcoming')
      .sort((a, b) => {
        if (!a.openingDate && !b.openingDate) return 0;
        if (!a.openingDate) return 1;
        if (!b.openingDate) return -1;
        return new Date(a.openingDate).getTime() - new Date(b.openingDate).getTime();
      }),
    [shows],
  );

  // Main list: only open/closed shows with enough reviews
  const filteredAndSortedShows = useMemo(() => {
    let result = shows.filter(show => {
      if (show.status === 'upcoming') return false;
      return show.criticScore && operaHasEnoughReviews(show);
    });

    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    result.sort((a, b) => {
      switch (sort) {
        case 'score_desc': {
          const aScore = operaHasEnoughReviews(a) ? (a.criticScore?.score ?? -1) : -1;
          const bScore = operaHasEnoughReviews(b) ? (b.criticScore?.score ?? -1) : -1;
          return bScore - aScore;
        }
        case 'score_asc': {
          const aScore = operaHasEnoughReviews(a) ? (a.criticScore?.score ?? Infinity) : Infinity;
          const bScore = operaHasEnoughReviews(b) ? (b.criticScore?.score ?? Infinity) : Infinity;
          return aScore - bScore;
        }
        case 'alpha':
          return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        case 'alpha_desc':
          return b.title.toLowerCase().localeCompare(a.title.toLowerCase());
        case 'recent_asc':
          if (!a.openingDate && !b.openingDate) return 0;
          if (!a.openingDate) return 1;
          if (!b.openingDate) return -1;
          return new Date(a.openingDate).getTime() - new Date(b.openingDate).getTime();
        case 'recent':
        default:
          if (!a.openingDate && !b.openingDate) return 0;
          if (!a.openingDate) return 1;
          if (!b.openingDate) return -1;
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
      }
    });

    return result;
  }, [shows, statusFilter, sort]);

  const openCount = useMemo(
    () => shows.filter(s => s.status === 'open').length,
    [shows],
  );

  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      {/* Hero */}
      <div className="mb-4 sm:mb-8">
        <div className="relative inline-block mb-3">
          <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white tracking-tight">
            Opera<span className="bg-gradient-to-r from-amber-400 to-amber-500 bg-clip-text text-transparent">Scorecard</span>
          </h1>
          <span className="hidden sm:inline-block ml-2 align-middle text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 absolute -top-3 sm:-top-4 right-0 translate-x-full">
            Beta
          </span>
        </div>
        <div className="relative inline-block mb-2">
          <h1 className="block sm:hidden text-3xl font-extrabold text-white tracking-tight">
            Opera<span className="bg-gradient-to-r from-amber-400 to-amber-500 bg-clip-text text-transparent">Scorecard</span>
          </h1>
          <span className="sm:hidden ml-2 align-middle inline-block text-[10px] font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 absolute -top-1 right-0 translate-x-full">
            Beta
          </span>
        </div>
        <p className="text-gray-400 text-lg sm:text-xl">
          Every Met production. Every critic. One score.
        </p>
        <p className="text-gray-500 text-sm sm:text-base mt-1">
          {totalShows} productions. {totalReviews.toLocaleString()} critic reviews. And counting.
        </p>
        {openCount > 0 && (
          <p className="text-gray-500 text-xs sm:text-sm mt-1">
            {openCount} currently running at the Metropolitan Opera House.
          </p>
        )}
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <ToggleBar
          label="STATUS:"
          options={[
            { value: 'now_playing' as StatusParam, label: 'PLAYING' },
            { value: 'all' as StatusParam, label: 'ALL' },
            { value: 'closed' as StatusParam, label: 'CLOSED' },
          ]}
          value={status}
          onChange={(s) => updateParams({ status: s })}
          ariaLabel="Filter by status"
        />

        <ToggleBar
          label="SORT:"
          options={[
            {
              value: 'recent' as SortParam,
              label: `NEWEST ${getSortArrow('recent', sort)}`.trim(),
              title: sort === 'recent' ? 'Sorted newest first, click to reverse' : sort === 'recent_asc' ? 'Sorted oldest first, click to reverse' : 'Click to sort by opening date',
            },
            {
              value: 'score_desc' as SortParam,
              label: `CRITICS ${getSortArrow('score_desc', sort)}`.trim(),
              title: sort === 'score_desc' ? 'Sorted by critic score, highest first, click to reverse' : sort === 'score_asc' ? 'Sorted by critic score, lowest first, click to reverse' : 'Click to sort by critic score',
            },
            {
              value: 'alpha' as SortParam,
              label: `A-Z ${getSortArrow('alpha', sort)}`.trim(),
              title: sort === 'alpha' ? 'Sorted alphabetically, A to Z, click to reverse' : sort === 'alpha_desc' ? 'Sorted alphabetically, Z to A, click to reverse' : 'Click to sort alphabetically',
            },
          ]}
          value={normalizeSort(sort) as SortParam}
          onChange={(s) => updateParams({ sort: getNextSort(s, sort) })}
          ariaLabel="Sort productions"
        />
      </div>

      {/* Show list */}
      <h2 className="sr-only">Met Opera productions</h2>
      <div className="space-y-3" role="list" aria-label="Met Opera productions">
        {filteredAndSortedShows.map((show, index) => (
          <ShowListCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} scoreMode={scoreMode} overrideHref={`/opera/${operaTitleSlug(show.slug)}`} />
        ))}
        {filteredAndSortedShows.length === 0 && (
          <p className="text-gray-500 text-sm py-8 text-center">
            No productions match the current filter.
          </p>
        )}
      </div>

      {filteredAndSortedShows.length > 0 && (
        <div className="mt-8 flex items-baseline justify-between text-sm text-gray-400">
          <span>{filteredAndSortedShows.length} production{filteredAndSortedShows.length !== 1 ? 's' : ''}</span>
          <Link href="/methodology" prefetch={false} className="text-brand hover:text-brand-hover transition-colors">
            How scores work →
          </Link>
        </div>
      )}

      {/* Upcoming shelf — below main list, sorted by opening date */}
      {upcomingShows.length > 0 && (
        <section className="mt-8 pt-8 border-t border-white/5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white">Coming Next Season</h2>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
            {upcomingShows.map((show) => (
              <MiniShowCard key={show.id} show={show} />
            ))}
          </div>
        </section>
      )}

      {/* Score Legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-8 mb-4 text-xs text-gray-400">
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.mustSee.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.mustSee.color, boxShadow: '0 0 6px rgba(255, 215, 0, 0.5)' }}></div>
          <span>{SCORE_TIERS.mustSee.range} {SCORE_TIERS.mustSee.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.recommended.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.recommended.color }}></div>
          <span>{SCORE_TIERS.recommended.range} {SCORE_TIERS.recommended.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.worthSeeing.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.worthSeeing.color }}></div>
          <span>{SCORE_TIERS.worthSeeing.range} {SCORE_TIERS.worthSeeing.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.skippable.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.skippable.color }}></div>
          <span>{SCORE_TIERS.skippable.range} {SCORE_TIERS.skippable.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.stayAway.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.stayAway.color }}></div>
          <span>{SCORE_TIERS.stayAway.range} {SCORE_TIERS.stayAway.label}</span>
        </div>
      </div>
    </div>
  );
}

export default function OperaPageClient(props: OperaPageClientProps) {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-8 sm:mb-10">
          <div className="text-4xl sm:text-6xl font-extrabold text-white mb-3 tracking-tight" aria-hidden="true">
            Opera<span className="bg-gradient-to-r from-amber-400 to-amber-500 bg-clip-text text-transparent">Scorecard</span>
            <span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
          </div>
          <p className="text-gray-400 text-lg sm:text-xl">Every Met production. Every critic. One score.</p>
        </div>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-overlay rounded w-3/4"></div>
          <div className="h-32 bg-surface-overlay rounded-xl"></div>
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-24 bg-surface-overlay rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    }>
      <OperaPageInner {...props} />
    </Suspense>
  );
}
