'use client';

import { useMemo, memo, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getAllShows, ComputedShow, getDataStats, getBestOfList, getUpcomingShows } from '@/lib/data';

// URL parameter values
type StatusParam = 'now_playing' | 'closed' | 'upcoming' | 'all';
type SortParam = 'recent' | 'score_desc' | 'score_asc' | 'alpha' | 'closing_soon';
type TypeParam = 'all' | 'musical' | 'play';

// Internal filter values
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';

// Defaults
const DEFAULT_STATUS: StatusParam = 'now_playing';
const DEFAULT_SORT: SortParam = 'recent';
const DEFAULT_TYPE: TypeParam = 'all';

// Map URL params to internal values
const statusParamToFilter: Record<StatusParam, StatusFilter> = {
  now_playing: 'open',
  closed: 'closed',
  upcoming: 'previews',
  all: 'all',
};

// Labels for display in filter chips
const statusLabels: Record<StatusParam, string> = {
  now_playing: 'Now Playing',
  closed: 'Closed',
  upcoming: 'Upcoming',
  all: 'All',
};

const sortLabels: Record<SortParam, string> = {
  recent: 'Recently Opened',
  score_desc: 'Highest Rated',
  score_asc: 'Lowest Rated',
  alpha: 'A-Z',
  closing_soon: 'Closing Soon',
};

const typeLabels: Record<TypeParam, string> = {
  all: 'All',
  musical: 'Musicals',
  play: 'Plays',
};

function ScoreBadge({ score, size = 'md', reviewCount }: { score?: number | null; size?: 'sm' | 'md' | 'lg'; reviewCount?: number }) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg rounded-lg',
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-16 h-16 text-3xl rounded-xl',
  }[size];

  // Show TBD if fewer than 5 reviews
  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;

  if (roundedScore >= 85) {
    colorClass = 'score-high ring-2 ring-accent-gold/50';
  } else if (roundedScore >= 75) {
    colorClass = 'score-high';
  } else if (roundedScore >= 65) {
    colorClass = 'score-medium';
  } else if (roundedScore >= 55) {
    colorClass = 'bg-orange-500 text-white';
  } else {
    colorClass = 'score-low';
  }

  return (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );
}

// Status pill - subtle background with accent color
function StatusBadge({ status }: { status: string }) {
  const label = {
    open: 'NOW PLAYING',
    closed: 'CLOSED',
    previews: 'IN PREVIEWS',
  }[status] || status.toUpperCase();

  const colorClass = {
    open: 'bg-emerald-500/15 text-emerald-400',
    closed: 'bg-gray-500/15 text-gray-400',
    previews: 'bg-purple-500/15 text-purple-400',
  }[status] || 'bg-gray-500/15 text-gray-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

// Format pill - outline style
function FormatPill({ type }: { type: string }) {
  const isMusical = type === 'musical' || type === 'revival';
  const label = isMusical ? 'MUSICAL' : 'PLAY';
  const colorClass = isMusical
    ? 'border-purple-500/50 text-purple-400'
    : 'border-blue-500/50 text-blue-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${colorClass}`}>
      {label}
    </span>
  );
}

// Production pill - solid muted fill
function ProductionPill({ isRevival }: { isRevival: boolean }) {
  const label = isRevival ? 'REVIVAL' : 'ORIGINAL';
  const colorClass = isRevival
    ? 'bg-gray-500/20 text-gray-400'
    : 'bg-amber-500/20 text-amber-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

// Limited Run badge - eye-catching for shows ending soon
function LimitedRunBadge() {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-rose-500/15 text-rose-400 border border-rose-500/30">
      LIMITED RUN
    </span>
  );
}

// Filter chip with remove button
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-brand/20 text-brand">
      {label}
      <button
        onClick={onRemove}
        className="ml-0.5 hover:bg-brand/30 rounded-full p-0.5 transition-colors"
        aria-label={`Remove ${label} filter`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatOpeningDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function SearchIcon() {
  return (
    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

const ShowCard = memo(function ShowCard({ show, index, hideStatus }: { show: ComputedShow; index: number; hideStatus: boolean }) {
  const score = show.criticScore?.score;
  const isRevival = show.type === 'revival';

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex gap-4 p-4 animate-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail - fixed aspect ratio prevents CLS */}
      <div className="flex-shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay aspect-square">
        {show.images?.thumbnail ? (
          <img
            src={show.images.thumbnail}
            alt=""
            aria-hidden="true"
            loading="lazy"
            width={80}
            height={80}
            decoding="async"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 will-change-transform"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-2xl" aria-hidden="true">
            🎭
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-white group-hover:text-brand transition-colors truncate">
          {show.title}
        </h3>
        <p className="text-sm text-gray-500 mt-0.5 truncate">{show.venue}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <FormatPill type={show.type} />
          <ProductionPill isRevival={isRevival} />
          {show.limitedRun && <LimitedRunBadge />}
          {!hideStatus && <StatusBadge status={show.status} />}
          <span className="text-[10px] text-gray-500">
            Opened {formatOpeningDate(show.openingDate)}
            {show.status === 'closed' && show.closingDate && (
              <> · Closed {formatOpeningDate(show.closingDate)}</>
            )}
          </span>
        </div>
      </div>

      {/* Score */}
      <div className="flex-shrink-0 flex flex-col items-center justify-center">
        <ScoreBadge score={score} size="lg" reviewCount={show.criticScore?.reviewCount} />
        {show.criticScore && (
          <span className="text-xs text-gray-400 mt-1 font-medium">
            {show.criticScore.reviewCount} reviews
          </span>
        )}
      </div>
    </Link>
  );
});

// Compact card for featured rows
const MiniShowCard = memo(function MiniShowCard({ show }: { show: ComputedShow }) {
  const score = show.criticScore?.score;

  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex-shrink-0 w-36 sm:w-40 group"
    >
      <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[3/4] mb-2">
        {show.images?.poster || show.images?.thumbnail ? (
          <img
            src={show.images.poster || show.images.thumbnail}
            alt=""
            aria-hidden="true"
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl" aria-hidden="true">
            🎭
          </div>
        )}
        {/* Score overlay */}
        <div className="absolute bottom-2 right-2">
          <ScoreBadge score={score} size="sm" reviewCount={show.criticScore?.reviewCount} />
        </div>
      </div>
      <h4 className="font-medium text-white text-sm group-hover:text-brand transition-colors line-clamp-2">
        {show.title}
      </h4>
    </Link>
  );
});

// Featured row with horizontal scroll
function FeaturedRow({ title, shows, viewAllHref }: { title: string; shows: ComputedShow[]; viewAllHref?: string }) {
  if (shows.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">{title}</h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-brand transition-colors"
          >
            See all <ChevronRightIcon />
          </Link>
        )}
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show) => (
          <MiniShowCard key={show.id} show={show} />
        ))}
      </div>
    </section>
  );
}

// Inner component that uses searchParams
function HomePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Parse URL params with defaults
  const statusParam = (searchParams.get('status') as StatusParam) || DEFAULT_STATUS;
  const sortParam = (searchParams.get('sort') as SortParam) || DEFAULT_SORT;
  const typeParam = (searchParams.get('type') as TypeParam) || DEFAULT_TYPE;
  const searchQuery = searchParams.get('q') || '';

  // Validate params (use default if invalid)
  const status: StatusParam = ['now_playing', 'closed', 'upcoming', 'all'].includes(statusParam) ? statusParam : DEFAULT_STATUS;
  const sort: SortParam = ['recent', 'score_desc', 'score_asc', 'alpha', 'closing_soon'].includes(sortParam) ? sortParam : DEFAULT_SORT;
  const type: TypeParam = ['all', 'musical', 'play'].includes(typeParam) ? typeParam : DEFAULT_TYPE;

  // Internal status filter value
  const statusFilter = statusParamToFilter[status];

  // Update URL helper
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        params.delete(key);
      } else {
        // Don't include default values in URL
        const isDefault =
          (key === 'status' && value === DEFAULT_STATUS) ||
          (key === 'sort' && value === DEFAULT_SORT) ||
          (key === 'type' && value === DEFAULT_TYPE) ||
          (key === 'q' && value === '');

        if (isDefault) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
    }

    const paramString = params.toString();
    router.push(paramString ? `${pathname}?${paramString}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  // Check if any non-default filters are active
  const hasActiveFilters = status !== DEFAULT_STATUS || sort !== DEFAULT_SORT || type !== DEFAULT_TYPE || searchQuery !== '';

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    router.push(pathname, { scroll: false });
  }, [pathname, router]);

  const shows = useMemo(() => getAllShows(), []);

  // Featured rows data
  const bestMusicals = useMemo(() => getBestOfList('musicals')?.shows || [], []);
  const bestPlays = useMemo(() => getBestOfList('plays')?.shows || [], []);
  const upcomingShows = useMemo(() => getUpcomingShows(), []);

  const filteredAndSortedShows = useMemo(() => {
    // Only include shows with reviews
    let result = shows.filter(show => show.criticScore && show.criticScore.reviewCount > 0);

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Type filter
    if (type !== 'all') {
      result = result.filter(show => {
        const isMusical = show.type === 'musical' || show.type === 'revival';
        return type === 'musical' ? isMusical : !isMusical;
      });
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(show =>
        show.title.toLowerCase().includes(query) ||
        show.venue.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      switch (sort) {
        case 'score_desc':
          return (b.criticScore?.score ?? -1) - (a.criticScore?.score ?? -1);
        case 'score_asc':
          return (a.criticScore?.score ?? -1) - (b.criticScore?.score ?? -1);
        case 'alpha':
          return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        case 'closing_soon': {
          // Shows with closing dates first, sorted by closest date
          const aClose = a.closingDate ? new Date(a.closingDate).getTime() : Infinity;
          const bClose = b.closingDate ? new Date(b.closingDate).getTime() : Infinity;
          return aClose - bClose;
        }
        case 'recent':
        default:
          // Most recent opening date first
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
      }
    });

    return result;
  }, [shows, statusFilter, type, searchQuery, sort]);

  // Hide status chip when it would be redundant
  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Hero Header */}
      <div className="mb-8 sm:mb-10">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-2 tracking-tight">
          Broadway<span className="text-gradient">MetaScores</span>
        </h1>
        <p className="text-gray-400 text-base sm:text-lg">
          Every show. Every review. One score.
        </p>
      </div>

      {/* Featured Rows */}
      <FeaturedRow
        title="Best Musicals This Season"
        shows={bestMusicals}
        viewAllHref="/?type=musical&sort=score_desc"
      />
      <FeaturedRow
        title="Best Plays This Season"
        shows={bestPlays}
        viewAllHref="/?type=play&sort=score_desc"
      />
      <FeaturedRow
        title="New & Upcoming"
        shows={upcomingShows}
      />

      {/* Search */}
      <div id="search" className="relative mb-6 scroll-mt-24" role="search">
        <label htmlFor="show-search" className="sr-only">Search Broadway shows</label>
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          id="show-search"
          type="search"
          placeholder="Search shows..."
          value={searchQuery}
          onChange={(e) => updateParams({ q: e.target.value })}
          className="search-input pl-12 focus-visible:outline-none"
          autoComplete="off"
        />
      </div>

      {/* Type Filter Pills */}
      <div className="flex items-center gap-2 mb-4" role="group" aria-label="Filter by type">
        {(['all', 'musical', 'play'] as const).map((t) => (
          <button
            key={t}
            onClick={() => updateParams({ type: t })}
            aria-pressed={type === t}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
              type === t
                ? 'bg-brand text-white shadow-glow-sm'
                : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            {t === 'all' ? 'All' : t === 'musical' ? 'Musicals' : 'Plays'}
          </button>
        ))}
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 text-sm">
        <div className="flex items-center gap-2" role="group" aria-label="Filter by status">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">STATUS</span>
          {(['now_playing', 'all', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ status: s })}
              aria-pressed={status === s}
              className={`px-2 py-1 rounded transition-colors text-[11px] font-medium uppercase tracking-wider ${
                status === s ? 'text-brand' : 'text-gray-400 hover:text-white'
              }`}
            >
              {s === 'all' ? 'ALL' : s === 'now_playing' ? 'NOW PLAYING' : 'CLOSED'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Sort shows">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">SORT</span>
          {(['recent', 'score_desc', 'alpha', 'closing_soon'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ sort: s })}
              aria-pressed={sort === s}
              className={`px-2 py-1 rounded text-[11px] font-medium uppercase tracking-wider transition-colors ${
                sort === s ? 'text-brand' : 'text-gray-400 hover:text-white'
              }`}
            >
              {s === 'recent' ? 'RECENT' : s === 'score_desc' ? 'TOP RATED' : s === 'alpha' ? 'A-Z' : 'CLOSING SOON'}
            </button>
          ))}
        </div>
      </div>

      {/* Active Filter Chips */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {status !== DEFAULT_STATUS && (
            <FilterChip
              label={`Status: ${statusLabels[status]}`}
              onRemove={() => updateParams({ status: null })}
            />
          )}
          {sort !== DEFAULT_SORT && (
            <FilterChip
              label={`Sort: ${sortLabels[sort]}`}
              onRemove={() => updateParams({ sort: null })}
            />
          )}
          {type !== DEFAULT_TYPE && (
            <FilterChip
              label={`Type: ${typeLabels[type]}`}
              onRemove={() => updateParams({ type: null })}
            />
          )}
          {searchQuery && (
            <FilterChip
              label={`Search: "${searchQuery}"`}
              onRemove={() => updateParams({ q: null })}
            />
          )}
          <button
            onClick={clearAllFilters}
            className="text-xs text-gray-400 hover:text-white transition-colors ml-2"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Score Legend */}
      <div className="flex flex-wrap items-center gap-4 mb-6 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-high ring-1 ring-accent-gold/50"></div>
          <span>85+ Must-See</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-high"></div>
          <span>75-84 Recommended</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-medium"></div>
          <span>65-74 Worth Seeing</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-orange-500"></div>
          <span>55-64 Skippable</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-low"></div>
          <span>&lt;55 Stay Away</span>
        </div>
      </div>

      {/* Show List */}
      <div className="space-y-3" role="list" aria-label="Broadway shows">
        {filteredAndSortedShows.map((show, index) => (
          <ShowCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} />
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-16 px-6" role="status" aria-live="polite">
          <div className="w-16 h-16 rounded-full bg-surface-overlay mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No shows found</h3>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">
            {searchQuery
              ? `No shows match "${searchQuery}". Try adjusting your search or filters.`
              : 'No shows match your current filters.'}
          </p>
          <button
            onClick={clearAllFilters}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-pill bg-brand/10 text-brand hover:bg-brand/20 transition-colors text-sm font-semibold"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Reset filters
          </button>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between text-sm text-gray-500">
        <span>{filteredAndSortedShows.length} shows</span>
        <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
          How scores work →
        </Link>
      </div>

      {/* Total Review Count */}
      <div className="mt-12 py-6 border-t border-white/5 text-center">
        <p className="text-gray-400 text-sm">
          Aggregating <span className="text-white font-semibold">{getDataStats().totalReviews.toLocaleString()}</span> reviews and counting
        </p>
      </div>
    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function HomePage() {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-8 sm:mb-10">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-2 tracking-tight">
            Broadway<span className="text-gradient">MetaScores</span>
          </h1>
          <p className="text-gray-400 text-base sm:text-lg">
            Every show. Every review. One score.
          </p>
        </div>
        <div className="animate-pulse space-y-4">
          <div className="h-12 bg-surface-overlay rounded-xl"></div>
          <div className="h-8 bg-surface-overlay rounded w-3/4"></div>
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-24 bg-surface-overlay rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    }>
      <HomePageInner />
    </Suspense>
  );
}
