'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'criticScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const sizeClass = {
    sm: 'score-badge-sm',
    md: 'score-badge-md',
    lg: 'score-badge-lg',
    xl: 'score-badge-xl',
  }[size];

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none`}>
        —
      </div>
    );
  }

  const colorClass = score >= 70 ? 'score-high' : score >= 50 ? 'score-medium' : 'score-low';

  return (
    <div className={`score-badge ${sizeClass} ${colorClass}`}>
      {score}
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
    open: 'Open',
    closed: 'Closed',
    previews: 'Previews',
  }[status] || status;

  return <span className={`chip ${chipClass}`}>{label}</span>;
}

function ConfidenceBadge({ level }: { level?: string }) {
  if (!level) return null;

  const className = {
    high: 'confidence-high',
    medium: 'confidence-medium',
    low: 'confidence-low',
  }[level] || 'confidence-low';

  return (
    <span className={`confidence-badge ${className}`}>
      {level}
    </span>
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

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Filter by search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(show =>
        show.title.toLowerCase().includes(query) ||
        show.venue.toLowerCase().includes(query)
      );
    }

    // Sort
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
      setSortDirection('desc');
    }
  };

  const SortHeader = ({ field, label, className = '' }: { field: SortField; label: string; className?: string }) => (
    <button
      onClick={() => handleSort(field)}
      className={`flex items-center gap-1 hover:text-white transition text-xs font-semibold uppercase tracking-wider ${sortField === field ? 'text-brand' : 'text-gray-400'} ${className}`}
    >
      <span>{label}</span>
      {sortField === field && <span className="text-brand">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 text-balance">Broadway Show Scores</h1>
        <p className="text-gray-400 text-sm sm:text-base">
          Aggregated critic reviews for Broadway productions.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 mb-6">
        <input
          type="text"
          placeholder="Search shows or venues..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
        <div className="filter-pills">
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={statusFilter === status ? 'filter-pill-active' : 'filter-pill-inactive'}
            >
              {status === 'all' ? 'All Shows' : status === 'open' ? 'Now Playing' : 'Closed'}
            </button>
          ))}
        </div>
      </div>

      {/* Score Legend */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-6 mb-4 text-xs sm:text-sm text-gray-400">
        <span className="hidden sm:inline">Score scale:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 sm:w-4 sm:h-4 rounded bg-score-high"></div>
          <span>70+ Good</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 sm:w-4 sm:h-4 rounded bg-score-medium"></div>
          <span>50-69 Mixed</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 sm:w-4 sm:h-4 rounded bg-score-low"></div>
          <span>&lt;50 Poor</span>
        </div>
      </div>

      {/* Desktop Table */}
      <div className="hidden md:block card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <SortHeader field="title" label="Show" />
              </th>
              <th className="text-center">
                <SortHeader field="criticScore" label="Critics Score" className="justify-center" />
              </th>
              <th className="text-center">Reviews</th>
              <th>Status</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSortedShows.map((show) => (
              <tr key={show.id}>
                <td>
                  <Link href={`/show/${show.slug}`} className="block group">
                    <div className="font-medium text-white group-hover:text-brand transition">
                      {show.title}
                    </div>
                    <div className="text-sm text-gray-400">{show.venue}</div>
                  </Link>
                </td>
                <td>
                  <div className="flex justify-center">
                    <Link href={`/show/${show.slug}`}>
                      <ScoreBadge score={show.criticScore?.score} />
                    </Link>
                  </div>
                </td>
                <td className="text-center text-gray-400 text-sm">
                  {show.criticScore?.reviewCount ?? '—'}
                </td>
                <td>
                  <StatusChip status={show.status} />
                </td>
                <td>
                  <ConfidenceBadge level={show.confidence?.level} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-3">
        {filteredAndSortedShows.map((show) => (
          <Link
            key={show.id}
            href={`/show/${show.slug}`}
            className="card-interactive block p-4"
          >
            <div className="flex items-start gap-4">
              <ScoreBadge score={show.criticScore?.score} size="lg" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white leading-tight">{show.title}</div>
                <div className="text-sm text-gray-400 mt-0.5">{show.venue}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <StatusChip status={show.status} />
                  <ConfidenceBadge level={show.confidence?.level} />
                </div>
                {show.criticScore && (
                  <div className="text-xs text-gray-500 mt-2">
                    {show.criticScore.reviewCount} reviews
                  </div>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-12 text-gray-400">
          No shows match your search.
        </div>
      )}

      <div className="mt-6 text-sm text-gray-500">
        Showing {filteredAndSortedShows.length} of {shows.length} shows
      </div>
    </div>
  );
}
