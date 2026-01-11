'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getShowListItems } from '@/data/shows';
import { ShowListItem, ShowStatus, ConfidenceLevel } from '@/types/show';

type SortField = 'metascore' | 'criticScore' | 'audienceScore' | 'buzzScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';

function ScoreBadge({ score, size = 'md' }: { score?: number; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-10 h-10 text-sm',
    md: 'w-12 h-12 text-lg',
    lg: 'w-16 h-16 text-2xl',
  };

  if (score === undefined) {
    return (
      <div className={`${sizeClasses[size]} score-badge score-badge-none`}>
        —
      </div>
    );
  }

  const colorClass = score >= 70 ? 'score-badge-high' : score >= 50 ? 'score-badge-medium' : 'score-badge-low';

  return (
    <div className={`${sizeClasses[size]} score-badge ${colorClass}`}>
      {score}
    </div>
  );
}

function StatusChip({ status }: { status: ShowStatus }) {
  const labels: Record<ShowStatus, string> = {
    previews: 'Previews',
    opened: 'Open',
    closing: 'Closing',
    closed: 'Closed',
  };

  return (
    <span className={`status-chip status-${status}`}>
      {labels[status]}
    </span>
  );
}

function ConfidenceBadge({ level }: { level?: ConfidenceLevel }) {
  if (!level) return null;

  return (
    <span className={`confidence-badge confidence-${level}`}>
      {level}
    </span>
  );
}

export default function HomePage() {
  const [sortField, setSortField] = useState<SortField>('metascore');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [statusFilter, setStatusFilter] = useState<ShowStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const shows = getShowListItems();

  const filteredAndSortedShows = useMemo(() => {
    let result = [...shows];

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(show =>
        show.title.toLowerCase().includes(query) ||
        show.venue.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      let aVal: string | number | undefined;
      let bVal: string | number | undefined;

      switch (sortField) {
        case 'metascore':
          aVal = a.metascore ?? -1;
          bVal = b.metascore ?? -1;
          break;
        case 'criticScore':
          aVal = a.criticScore ?? -1;
          bVal = b.criticScore ?? -1;
          break;
        case 'audienceScore':
          aVal = a.audienceScore ?? -1;
          bVal = b.audienceScore ?? -1;
          break;
        case 'buzzScore':
          aVal = a.buzzScore ?? -1;
          bVal = b.buzzScore ?? -1;
          break;
        case 'title':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'openingDate':
          aVal = a.openingDate;
          bVal = b.openingDate;
          break;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });

    return result;
  }, [shows, sortField, sortDirection, statusFilter, searchQuery]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <button
      onClick={() => handleSort(field)}
      className={`flex items-center space-x-1 hover:text-white transition ${sortField === field ? 'text-green-400' : 'text-gray-400'}`}
    >
      <span>{label}</span>
      {sortField === field && (
        <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>
      )}
    </button>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Broadway Show Scores</h1>
        <p className="text-gray-400">
          Aggregated critic, audience, and buzz scores for current Broadway productions.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex-1 min-w-[200px]">
          <input
            type="text"
            placeholder="Search shows..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'opened', 'previews', 'closing', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg transition ${statusFilter === status
                ? 'bg-green-500 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
            >
              {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 mb-4 text-sm text-gray-400">
        <span>Score scale:</span>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-green-500"></div>
          <span>70+ (Good)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-yellow-500"></div>
          <span>50-69 (Mixed)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-red-500"></div>
          <span>&lt;50 (Poor)</span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left">
                  <SortHeader field="title" label="Show" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="metascore" label="Overall" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="criticScore" label="Critics" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="audienceScore" label="Audience" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="buzzScore" label="Buzz" />
                </th>
                <th className="px-4 py-3 text-left text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-gray-400">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {filteredAndSortedShows.map((show) => (
                <tr key={show.id} className="hover:bg-gray-750 transition">
                  <td className="px-4 py-4">
                    <Link href={`/show/${show.slug}`} className="block">
                      <div className="font-medium text-white hover:text-green-400 transition">
                        {show.title}
                      </div>
                      <div className="text-sm text-gray-400">{show.venue}</div>
                      {show.oneLiner && (
                        <div className="text-sm text-gray-500 mt-1 line-clamp-1">
                          {show.oneLiner}
                        </div>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <Link href={`/show/${show.slug}`}>
                        <ScoreBadge score={show.metascore} />
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <ScoreBadge score={show.criticScore} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <ScoreBadge score={show.audienceScore} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <ScoreBadge score={show.buzzScore} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <StatusChip status={show.status} />
                  </td>
                  <td className="px-4 py-4">
                    <ConfidenceBadge level={show.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          No shows match your filters.
        </div>
      )}

      <div className="mt-4 text-sm text-gray-500">
        Showing {filteredAndSortedShows.length} of {shows.length} shows
      </div>
    </div>
  );
}
