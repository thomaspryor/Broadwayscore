'use client';

import { useState, useMemo, memo } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'criticScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';
type TypeFilter = 'all' | 'musicals' | 'plays';

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
            {show.status === 'closed' && show.closingDate
              ? `Closed ${formatOpeningDate(show.closingDate)}`
              : `Opened ${formatOpeningDate(show.openingDate)}`}
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

export default function HomePage() {
  const [sortField, setSortField] = useState<SortField>('criticScore');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const shows = useMemo(() => getAllShows(), []);

  const filteredAndSortedShows = useMemo(() => {
    // Only include shows with reviews
    let result = shows.filter(show => show.criticScore && show.criticScore.reviewCount > 0);

    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    if (typeFilter !== 'all') {
      if (typeFilter === 'musicals') {
        result = result.filter(show => show.type === 'musical' || show.type === 'revival');
      } else if (typeFilter === 'plays') {
        result = result.filter(show => show.type === 'play');
      }
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(show =>
        show.title.toLowerCase().includes(query) ||
        show.venue.toLowerCase().includes(query)
      );
    }

    result.sort((a, b) => {
      let aVal: string | number | null;
      let bVal: string | number | null;

      switch (sortField) {
        case 'criticScore':
          aVal = a.criticScore?.score ?? -1;
          bVal = b.criticScore?.score ?? -1;
          break;
        case 'title':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'openingDate':
          aVal = a.openingDate;
          bVal = b.openingDate;
          break;
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      return sortDirection === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

    return result;
  }, [shows, sortField, sortDirection, statusFilter, typeFilter, searchQuery]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection(field === 'title' ? 'asc' : 'desc');
    }
  };

  // Hide status chip when it would be redundant (matches current filter)
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
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input pl-12 focus-visible:outline-none"
          autoComplete="off"
        />
      </div>

      {/* Type Filter Pills */}
      <div className="flex items-center gap-2 mb-4" role="group" aria-label="Filter by type">
        {(['all', 'musicals', 'plays'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            aria-pressed={typeFilter === type}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
              typeFilter === type
                ? 'bg-brand text-white shadow-glow-sm'
                : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
          >
            {type === 'all' ? 'All' : type === 'musicals' ? 'Musicals' : 'Plays'}
          </button>
        ))}
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 text-sm">
        <div className="flex items-center gap-2" role="group" aria-label="Filter by status">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500" id="status-filter-label">STATUS</span>
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
              className={`px-2 py-1 rounded transition-colors text-[11px] font-medium uppercase tracking-wider ${
                statusFilter === status ? 'text-brand' : 'text-gray-400 hover:text-white'
              }`}
            >
              {status === 'all' ? 'ALL' : status === 'open' ? 'NOW PLAYING' : 'CLOSED'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2" role="group" aria-label="Sort shows">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500" id="sort-label">SORT</span>
          <button
            onClick={() => handleSort('criticScore')}
            aria-pressed={sortField === 'criticScore'}
            className={`px-2 py-1 rounded text-[11px] font-medium uppercase tracking-wider ${sortField === 'criticScore' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            SCORE {sortField === 'criticScore' && (sortDirection === 'desc' ? '↓' : '↑')}
          </button>
          <button
            onClick={() => handleSort('title')}
            aria-pressed={sortField === 'title'}
            className={`px-2 py-1 rounded text-[11px] font-medium uppercase tracking-wider ${sortField === 'title' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            A-Z {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
          </button>
          <button
            onClick={() => handleSort('openingDate')}
            aria-pressed={sortField === 'openingDate'}
            className={`px-2 py-1 rounded text-[11px] font-medium uppercase tracking-wider ${sortField === 'openingDate' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            DATE {sortField === 'openingDate' && (sortDirection === 'desc' ? '↓' : '↑')}
          </button>
        </div>
      </div>

      {/* Score Legend */}
      <div className="flex flex-wrap items-center gap-4 mb-6 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-high ring-1 ring-accent-gold/50"></div>
          <span>85+ Must See</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-high"></div>
          <span>75-84 Great</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-medium"></div>
          <span>65-74 Good</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-orange-500"></div>
          <span>55-64 Tepid</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-low"></div>
          <span>&lt;55 Skip</span>
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
            onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
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
    </div>
  );
}
