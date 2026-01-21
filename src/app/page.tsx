'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { getAllShows } from '@/lib/data';

type SortField = 'score' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed';

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-10 h-10 text-sm',
    md: 'w-12 h-12 text-lg',
    lg: 'w-16 h-16 text-2xl',
  };

  if (score === undefined || score === null) {
    return (
      <div className={`${sizeClasses[size]} bg-gray-700 text-gray-500 rounded-lg flex items-center justify-center font-bold`}>
        —
      </div>
    );
  }

  const colorClass = score >= 70 ? 'bg-green-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  const textColor = score >= 50 && score < 70 ? 'text-gray-900' : 'text-white';

  return (
    <div className={`${sizeClasses[size]} ${colorClass} ${textColor} rounded-lg flex items-center justify-center font-bold`}>
      {score}
    </div>
  );
}

export default function HomePage() {
  const [sortField, setSortField] = useState<SortField>('score');
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
        case 'score':
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

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">Broadway Metascore</h1>
        <p className="text-gray-400 text-sm">
          Critic reviews aggregated for Broadway shows
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="text"
          placeholder="Search shows..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
        />
        <div className="flex gap-2">
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                statusFilter === status
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {status === 'all' ? 'All' : status === 'open' ? 'Now Playing' : 'Closed'}
            </button>
          ))}
        </div>
      </div>

      {/* Sort Options */}
      <div className="flex items-center gap-4 mb-4 text-sm">
        <span className="text-gray-500">Sort by:</span>
        {[
          { field: 'score' as const, label: 'Score' },
          { field: 'title' as const, label: 'Title' },
          { field: 'openingDate' as const, label: 'Opening Date' },
        ].map(({ field, label }) => (
          <button
            key={field}
            onClick={() => handleSort(field)}
            className={`transition ${sortField === field ? 'text-green-400' : 'text-gray-400 hover:text-white'}`}
          >
            {label}
            {sortField === field && (
              <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>
            )}
          </button>
        ))}
      </div>

      {/* Show List */}
      <div className="space-y-2">
        {filteredAndSortedShows.map((show) => (
          <Link
            key={show.id}
            href={`/show/${show.slug}`}
            className="flex items-center gap-4 p-3 bg-gray-800/50 hover:bg-gray-800 rounded-lg transition group"
          >
            {/* Thumbnail */}
            {show.images?.thumbnail ? (
              <div className="relative w-16 h-16 rounded overflow-hidden flex-shrink-0">
                <Image
                  src={show.images.thumbnail}
                  alt={show.title}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="w-16 h-16 bg-gray-700 rounded flex-shrink-0" />
            )}

            {/* Score */}
            <ScoreBadge score={show.criticScore?.score} />

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-white group-hover:text-green-400 transition truncate">
                {show.title}
              </div>
              <div className="text-sm text-gray-500 truncate">
                {show.venue}
                {show.criticScore && ` • ${show.criticScore.reviewCount} reviews`}
              </div>
            </div>

            {/* Status */}
            <div className={`text-xs px-2 py-1 rounded flex-shrink-0 ${
              show.status === 'open'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-gray-700 text-gray-500'
            }`}>
              {show.status === 'open' ? 'Open' : 'Closed'}
            </div>
          </Link>
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No shows found.
        </div>
      )}

      <div className="mt-6 text-sm text-gray-600">
        {filteredAndSortedShows.length} show{filteredAndSortedShows.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
