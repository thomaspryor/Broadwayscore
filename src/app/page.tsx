'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'criticScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg rounded-lg',
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-16 h-16 text-3xl rounded-xl',
  }[size];

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const colorClass = roundedScore >= 70 ? 'score-high' : roundedScore >= 50 ? 'score-medium' : 'score-low';

  return (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const label = {
    open: 'Now Playing',
    closed: 'Closed',
    previews: 'In Previews',
  }[status] || status;

  const colorClass = {
    open: 'text-emerald-500',
    closed: 'text-gray-500',
    previews: 'text-purple-400',
  }[status] || 'text-gray-500';

  return (
    <span className={`text-[11px] font-medium uppercase tracking-wider ${colorClass}`}>
      {label}
    </span>
  );
}

function TypeTag({ type }: { type: string }) {
  const label = type.charAt(0).toUpperCase() + type.slice(1);

  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
      {label}
    </span>
  );
}

function NewBadge() {
  return (
    <span className="text-[11px] font-bold uppercase tracking-wider text-brand">
      New
    </span>
  );
}

// Calculate if show is new based on reference date to avoid hydration mismatch
function isNewShow(openingDate: string, referenceDate: Date): boolean {
  const opening = new Date(openingDate);
  const daysSinceOpening = (referenceDate.getTime() - opening.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceOpening <= 60 && daysSinceOpening >= 0; // Within last 60 days
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

function ShowCard({ show, index, hideStatus, currentDate }: { show: ComputedShow; index: number; hideStatus: boolean; currentDate: Date | null }) {
  const score = show.criticScore?.score;
  const isNew = currentDate ? isNewShow(show.openingDate, currentDate) : false;

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex gap-4 p-4 animate-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail */}
      <div className="flex-shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay">
        {show.images?.thumbnail ? (
          <img
            src={show.images.thumbnail}
            alt=""
            aria-hidden="true"
            loading="lazy"
            width={80}
            height={80}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-2xl" aria-hidden="true">
            🎭
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-white group-hover:text-brand transition-colors truncate">
            {show.title}
          </h3>
          {isNew && <NewBadge />}
        </div>
        <p className="text-sm text-gray-500 mt-0.5 truncate">{show.venue}</p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <TypeTag type={show.type} />
          {!hideStatus && <StatusChip status={show.status} />}
          <span className="text-xs text-gray-600">
            Opened {formatOpeningDate(show.openingDate)}
          </span>
        </div>
      </div>

      {/* Score */}
      <div className="flex-shrink-0 flex flex-col items-center justify-center">
        <ScoreBadge score={score} size="lg" />
        {show.criticScore && (
          <span className="text-[10px] text-gray-500 mt-1">
            {show.criticScore.reviewCount} reviews
          </span>
        )}
      </div>
    </Link>
  );
}

export default function HomePage() {
  const [sortField, setSortField] = useState<SortField>('criticScore');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [searchQuery, setSearchQuery] = useState('');
  // Use state for current date to avoid hydration mismatch (server vs client time)
  const [currentDate, setCurrentDate] = useState<Date | null>(null);

  useEffect(() => {
    // Set current date only on client to avoid hydration mismatch
    setCurrentDate(new Date());
  }, []);

  const shows = useMemo(() => getAllShows(), []);

  const filteredAndSortedShows = useMemo(() => {
    // Only include shows with reviews
    let result = shows.filter(show => show.criticScore && show.criticScore.reviewCount > 0);

    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
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
  }, [shows, sortField, sortDirection, statusFilter, searchQuery]);

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

      {/* Filters & Sort */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 text-sm">
        <div className="flex items-center gap-2" role="group" aria-label="Filter by status">
          <span className="text-gray-500" id="status-filter-label">Status:</span>
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
              className={`px-2 py-1 rounded transition-colors ${
                statusFilter === status ? 'text-brand' : 'text-gray-400 hover:text-white'
              }`}
            >
              {status === 'all' ? 'All' : status === 'open' ? 'Now Playing' : 'Closed'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2" role="group" aria-label="Sort shows">
          <span className="text-gray-500" id="sort-label">Sort:</span>
          <button
            onClick={() => handleSort('criticScore')}
            aria-pressed={sortField === 'criticScore'}
            className={`px-2 py-1 rounded ${sortField === 'criticScore' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            Score {sortField === 'criticScore' && (sortDirection === 'desc' ? '↓' : '↑')}
          </button>
          <button
            onClick={() => handleSort('title')}
            aria-pressed={sortField === 'title'}
            className={`px-2 py-1 rounded ${sortField === 'title' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            A-Z {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
          </button>
          <button
            onClick={() => handleSort('openingDate')}
            aria-pressed={sortField === 'openingDate'}
            className={`px-2 py-1 rounded ${sortField === 'openingDate' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            Date {sortField === 'openingDate' && (sortDirection === 'desc' ? '↓' : '↑')}
          </button>
        </div>
      </div>

      {/* Score Legend */}
      <div className="flex items-center gap-6 mb-6 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-high"></div>
          <span>70+ Favorable</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-medium"></div>
          <span>50-69 Mixed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-low"></div>
          <span>&lt;50 Unfavorable</span>
        </div>
      </div>

      {/* Show List */}
      <div className="space-y-3" role="list" aria-label="Broadway shows">
        {filteredAndSortedShows.map((show, index) => (
          <ShowCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} currentDate={currentDate} />
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
