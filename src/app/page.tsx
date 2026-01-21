'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'metascore' | 'criticScore' | 'audienceScore' | 'buzzScore' | 'title' | 'openingDate';
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
    open: 'Now Playing',
    closed: 'Closed',
    previews: 'In Previews',
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

function SearchIcon() {
  return (
    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

export default function HomePage() {
  const [sortField, setSortField] = useState<SortField>('metascore');
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
        case 'metascore':
          aVal = a.metascore ?? -1;
          bVal = b.metascore ?? -1;
          break;
        case 'criticScore':
          aVal = a.criticScore?.score ?? -1;
          bVal = b.criticScore?.score ?? -1;
          break;
        case 'audienceScore':
          aVal = a.audienceScore?.score ?? -1;
          bVal = b.audienceScore?.score ?? -1;
          break;
        case 'buzzScore':
          aVal = a.buzzScore?.score ?? -1;
          bVal = b.buzzScore?.score ?? -1;
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
      className={`flex items-center gap-1.5 hover:text-white transition text-xs font-semibold uppercase tracking-wider ${sortField === field ? 'text-brand' : 'text-gray-400'} ${className}`}
    >
      <span>{label}</span>
      {sortField === field && (
        <span className="text-brand text-[10px]">{sortDirection === 'asc' ? '▲' : '▼'}</span>
      )}
    </button>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      {/* Hero Header */}
      <div className="mb-8 sm:mb-12">
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white mb-3 tracking-tight">
          Broadway <span className="text-gradient">Scores</span>
        </h1>
        <p className="text-gray-400 text-base sm:text-lg max-w-2xl">
          Aggregated ratings from critics, audiences, and the community. Find your next show.
        </p>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 mb-8">
        <div className="relative">
          <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
            <SearchIcon />
          </div>
          <input
            type="text"
            placeholder="Search shows or venues..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input pl-12"
          />
        </div>
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
      <div className="flex flex-wrap items-center gap-4 sm:gap-8 mb-6 text-xs sm:text-sm text-gray-400">
        <span className="text-gray-500 font-medium">Score guide:</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-score-high"></div>
          <span>70+ Great</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-score-medium"></div>
          <span>50-69 Mixed</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-score-low"></div>
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
                <SortHeader field="metascore" label="Overall" className="justify-center" />
              </th>
              <th className="text-center">
                <SortHeader field="criticScore" label="Critics" className="justify-center" />
              </th>
              <th className="text-center">
                <SortHeader field="audienceScore" label="Audience" className="justify-center" />
              </th>
              <th className="text-center">
                <SortHeader field="buzzScore" label="Buzz" className="justify-center" />
              </th>
              <th>Status</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSortedShows.map((show, index) => (
              <tr key={show.id} className="animate-in" style={{ animationDelay: `${index * 30}ms` }}>
                <td>
                  <Link href={`/show/${show.slug}`} className="block group">
                    <div className="font-semibold text-white group-hover:text-brand transition-colors">
                      {show.title}
                    </div>
                    <div className="text-sm text-gray-500 mt-0.5">{show.venue}</div>
                  </Link>
                </td>
                <td>
                  <div className="flex justify-center">
                    <Link href={`/show/${show.slug}`}>
                      <ScoreBadge score={show.metascore} />
                    </Link>
                  </div>
                </td>
                <td>
                  <div className="flex justify-center">
                    <ScoreBadge score={show.criticScore?.score} size="sm" />
                  </div>
                </td>
                <td>
                  <div className="flex justify-center">
                    <ScoreBadge score={show.audienceScore?.score} size="sm" />
                  </div>
                </td>
                <td>
                  <div className="flex justify-center">
                    <ScoreBadge score={show.buzzScore?.score} size="sm" />
                  </div>
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
      <div className="md:hidden space-y-4">
        {filteredAndSortedShows.map((show, index) => (
          <Link
            key={show.id}
            href={`/show/${show.slug}`}
            className="show-card animate-in"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="flex items-start gap-4">
              <ScoreBadge score={show.metascore} size="lg" />
              <div className="flex-1 min-w-0">
                <div className="show-card-title text-base">{show.title}</div>
                <div className="text-sm text-gray-500 mt-1">{show.venue}</div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <StatusChip status={show.status} />
                  <ConfidenceBadge level={show.confidence?.level} />
                </div>
              </div>
            </div>
            <div className="score-grid mt-5 pt-4 border-t border-white/5">
              <div className="score-grid-item">
                <div className="score-grid-label">Critics</div>
                <div className={`score-grid-value ${show.criticScore?.score ? (show.criticScore.score >= 70 ? 'text-score-high' : show.criticScore.score >= 50 ? 'text-score-medium' : 'text-score-low') : 'text-gray-500'}`}>
                  {show.criticScore?.score ?? '—'}
                </div>
              </div>
              <div className="score-grid-item">
                <div className="score-grid-label">Audience</div>
                <div className={`score-grid-value ${show.audienceScore?.score ? (show.audienceScore.score >= 70 ? 'text-score-high' : show.audienceScore.score >= 50 ? 'text-score-medium' : 'text-score-low') : 'text-gray-500'}`}>
                  {show.audienceScore?.score ?? '—'}
                </div>
              </div>
              <div className="score-grid-item">
                <div className="score-grid-label">Buzz</div>
                <div className={`score-grid-value ${show.buzzScore?.score ? (show.buzzScore.score >= 70 ? 'text-score-high' : show.buzzScore.score >= 50 ? 'text-score-medium' : 'text-score-low') : 'text-gray-500'}`}>
                  {show.buzzScore?.score ?? '—'}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-16">
          <div className="text-gray-500 text-lg">No shows match your search.</div>
          <button
            onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
            className="mt-4 text-brand hover:text-brand-hover transition-colors font-medium"
          >
            Clear filters
          </button>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between text-sm text-gray-500">
        <span>Showing {filteredAndSortedShows.length} of {shows.length} shows</span>
        <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors font-medium">
          How are scores calculated?
        </Link>
      </div>
    </div>
  );
}
