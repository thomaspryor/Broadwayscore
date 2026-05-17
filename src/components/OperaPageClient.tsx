'use client';

import { useState, useMemo, useCallback, startTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ShowListCard, ToggleBar, SCORE_TIERS } from '@/components/show-cards';
import type { ShowCardShow, ScoreModeParam } from '@/components/show-cards/types';
import { hasEnoughReviews } from '@/config/score-buckets';

export interface OperaPageClientProps {
  shows: ShowCardShow[];
  totalShows: number;
  totalReviews: number;
}

type StatusParam = 'now_playing' | 'previews' | 'closed' | 'all';
type SortParam = 'recent' | 'score_desc' | 'alpha';

const DEFAULT_STATUS: StatusParam = 'all';
const DEFAULT_SORT: SortParam = 'score_desc';

const statusParamToFilter: Record<StatusParam, string> = {
  now_playing: 'open',
  previews: 'previews',
  closed: 'closed',
  all: 'all',
};

function operaHasEnoughReviews(show: ShowCardShow): boolean {
  const rc = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(rc, 'off-broadway', t1t2);
}

function OperaPageInner({ shows, totalShows, totalReviews }: OperaPageClientProps) {
  const initialSearchParams = useSearchParams();

  const [filters, setFilters] = useState(() => ({
    status: (['now_playing', 'previews', 'closed', 'all'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (['recent', 'score_desc', 'alpha'].includes(initialSearchParams.get('sort') as string)
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

  const filteredAndSortedShows = useMemo(() => {
    let result = shows.filter(show => {
      if (show.status === 'previews' || show.status === 'upcoming') {
        return statusFilter === 'previews' || statusFilter === 'all';
      }
      return show.criticScore && operaHasEnoughReviews(show);
    });

    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    result.sort((a, b) => {
      switch (sort) {
        case 'score_desc': {
          const aScore = (a.status === 'previews' || !operaHasEnoughReviews(a)) ? -1 : (a.criticScore?.score ?? -1);
          const bScore = (b.status === 'previews' || !operaHasEnoughReviews(b)) ? -1 : (b.criticScore?.score ?? -1);
          return bScore - aScore;
        }
        case 'alpha':
          return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
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
    () => shows.filter(s => s.status === 'open' || s.status === 'previews').length,
    [shows],
  );

  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      {/* Hero */}
      <div className="mb-4 sm:mb-8">
        <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
          Opera<span className="text-gradient">Scorecard</span>
          <span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">
            Beta
          </span>
        </h1>
        <h1 className="block sm:hidden text-3xl font-extrabold text-white mb-2 tracking-tight">
          Opera<span className="text-gradient">Scorecard</span>
          <span className="ml-2 align-middle inline-block text-[10px] font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5">
            Beta
          </span>
        </h1>
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
            { value: 'previews' as StatusParam, label: 'PREVIEWS' },
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
            { value: 'recent' as SortParam, label: 'NEWEST' },
            { value: 'score_desc' as SortParam, label: 'CRITICS' },
            { value: 'alpha' as SortParam, label: 'A-Z' },
          ]}
          value={sort}
          onChange={(s) => updateParams({ sort: s })}
          ariaLabel="Sort productions"
        />
      </div>

      {/* Show list */}
      <h2 className="sr-only">Met Opera productions</h2>
      <div className="space-y-3" role="list" aria-label="Met Opera productions">
        {filteredAndSortedShows.map((show, index) => (
          <ShowListCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} scoreMode={scoreMode} />
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
            Opera<span className="text-gradient">Scorecard</span>
            <span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
          </div>
          <p className="text-gray-400 text-lg sm:text-xl">Every Met production. Every critic. One score.</p>
        </div>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-overlay rounded w-3/4"></div>
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
