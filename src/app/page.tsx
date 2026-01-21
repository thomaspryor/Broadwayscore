'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'criticScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = {
    sm: 'w-10 h-10 text-sm rounded-lg',
    md: 'w-12 h-12 text-lg rounded-xl',
    lg: 'w-14 h-14 text-xl rounded-xl',
  }[size];

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none`}>
        —
      </div>
    );
  }

  // Round to whole number for cleaner display
  const roundedScore = Math.round(score);
  const colorClass = roundedScore >= 70 ? 'score-high' : roundedScore >= 50 ? 'score-medium' : 'score-low';

  return (
    <div className={`score-badge ${sizeClass} ${colorClass}`}>
      {roundedScore}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const chipClass = {
    open: 'chip-open',
    closed: 'chip-closed',
    previews: 'chip-previews',
  }[status] || 'chip-closed';

  const label = {
    open: 'Now Playing',
    closed: 'Closed',
    previews: 'In Previews',
  }[status] || status;

  return <span className={`chip ${chipClass}`}>{label}</span>;
}

function TypeTag({ type }: { type: string }) {
  const config: Record<string, { label: string; className: string }> = {
    musical: { label: 'Musical', className: 'bg-purple-500/20 text-purple-400 border-purple-500/20' },
    play: { label: 'Play', className: 'bg-blue-500/20 text-blue-400 border-blue-500/20' },
    revival: { label: 'Revival', className: 'bg-amber-500/20 text-amber-400 border-amber-500/20' },
  };

  const { label, className } = config[type] || { label: type, className: 'bg-gray-500/20 text-gray-400 border-gray-500/20' };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide border ${className}`}>
      {label}
    </span>
  );
}

function NewBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-brand/20 text-brand text-[10px] font-bold uppercase tracking-wide">
      New
    </span>
  );
}

function isNewShow(openingDate: string): boolean {
  const opening = new Date(openingDate);
  const now = new Date();
  const daysSinceOpening = (now.getTime() - opening.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceOpening <= 60 && daysSinceOpening >= 0; // Within last 60 days
}

function formatOpeningDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function SearchIcon() {
  return (
    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function ShowCard({ show, index, hideStatus }: { show: ComputedShow; index: number; hideStatus: boolean }) {
  const score = show.criticScore?.score;
  const isNew = isNewShow(show.openingDate);

  return (
    <Link
      href={`/show/${show.slug}`}
      className="group card-interactive flex gap-4 p-4 animate-in"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail */}
      <div className="flex-shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay">
        {show.images?.thumbnail ? (
          <img
            src={show.images.thumbnail}
            alt={show.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-2xl">
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

  const shows = useMemo(() => getAllShows(), []);

  const filteredAndSortedShows = useMemo(() => {
    let result = [...shows];

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
          Broadway <span className="text-gradient">Scores</span>
        </h1>
        <p className="text-gray-400 text-base sm:text-lg">
          Critic scores aggregated from top publications.
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          type="text"
          placeholder="Search shows..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input pl-12"
        />
      </div>

      {/* Filters & Sort */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div className="filter-pills">
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={statusFilter === status ? 'filter-pill-active' : 'filter-pill-inactive'}
            >
              {status === 'all' ? 'All' : status === 'open' ? 'Now Playing' : 'Closed'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Sort:</span>
          <button
            onClick={() => handleSort('criticScore')}
            className={`px-2 py-1 rounded ${sortField === 'criticScore' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            Score {sortField === 'criticScore' && (sortDirection === 'desc' ? '↓' : '↑')}
          </button>
          <button
            onClick={() => handleSort('title')}
            className={`px-2 py-1 rounded ${sortField === 'title' ? 'text-brand' : 'text-gray-400 hover:text-white'}`}
          >
            A-Z {sortField === 'title' && (sortDirection === 'asc' ? '↑' : '↓')}
          </button>
          <button
            onClick={() => handleSort('openingDate')}
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
          <span>70+ Great</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-medium"></div>
          <span>50-69 Mixed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-score-low"></div>
          <span>&lt;50 Poor</span>
        </div>
      </div>

      {/* Show List */}
      <div className="space-y-3">
        {filteredAndSortedShows.map((show, index) => (
          <ShowCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} />
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-12">
          <div className="text-gray-500">No shows match your search.</div>
          <button
            onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
            className="mt-3 text-brand hover:text-brand-hover transition-colors text-sm font-medium"
          >
            Clear filters
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
