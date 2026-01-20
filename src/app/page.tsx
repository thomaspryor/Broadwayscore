'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getAllShows, ComputedShow } from '@/lib/data';

type SortField = 'metascore' | 'criticScore' | 'audienceScore' | 'buzzScore' | 'title' | 'openingDate';
type SortDirection = 'asc' | 'desc';
type StatusFilter = 'all' | 'open' | 'closed' | 'previews';

function ScoreBadge({ score, size = 'md' }: { score?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-10 h-10 text-sm',
    md: 'w-12 h-12 text-lg',
    lg: 'w-16 h-16 text-2xl',
  };

  if (score === undefined || score === null) {
    return (
      <div className={`${sizeClasses[size]} inline-flex items-center justify-center rounded-lg font-bold bg-gray-700 text-gray-500`}>
        —
      </div>
    );
  }

  const colorClass = score >= 70
    ? 'bg-green-500 text-white'
    : score >= 50
    ? 'bg-yellow-500 text-gray-900'
    : 'bg-red-500 text-white';

  return (
    <div className={`${sizeClasses[size]} inline-flex items-center justify-center rounded-lg font-bold ${colorClass}`}>
      {score}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    open: { label: 'Open', className: 'bg-green-500/20 text-green-300' },
    closed: { label: 'Closed', className: 'bg-gray-500/20 text-gray-400' },
    previews: { label: 'Previews', className: 'bg-purple-500/20 text-purple-300' },
  };

  const { label, className } = config[status] || { label: status, className: 'bg-gray-500/20 text-gray-400' };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function ConfidenceBadge({ level }: { level?: string }) {
  if (!level) return null;

  const className = level === 'high'
    ? 'bg-green-500/20 text-green-300'
    : level === 'medium'
    ? 'bg-yellow-500/20 text-yellow-300'
    : 'bg-red-500/20 text-red-300';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${className}`}>
      {level}
    </span>
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
      className={`flex items-center gap-1 hover:text-white transition ${sortField === field ? 'text-green-400' : 'text-gray-400'} ${className}`}
    >
      <span>{label}</span>
      {sortField === field && <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Broadway Show Scores</h1>
        <p className="text-gray-400">
          Aggregated critic reviews, audience ratings, and community buzz for Broadway productions.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search shows or venues..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0">
          {(['open', 'all', 'closed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg transition whitespace-nowrap ${
                statusFilter === status
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {status === 'all' ? 'All Shows' : status === 'open' ? 'Now Playing' : 'Closed'}
            </button>
          ))}
        </div>
      </div>

      {/* Score Legend */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 mb-4 text-sm text-gray-400">
        <span>Score scale:</span>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-green-500"></div>
          <span>70+ Good</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-yellow-500"></div>
          <span>50-69 Mixed</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-red-500"></div>
          <span>&lt;50 Poor</span>
        </div>
      </div>

      {/* Desktop Table */}
      <div className="hidden md:block bg-gray-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-900">
              <tr>
                <th className="px-4 py-3 text-left">
                  <SortHeader field="title" label="Show" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="metascore" label="Overall" className="justify-center" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="criticScore" label="Critics" className="justify-center" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="audienceScore" label="Audience" className="justify-center" />
                </th>
                <th className="px-4 py-3 text-center">
                  <SortHeader field="buzzScore" label="Buzz" className="justify-center" />
                </th>
                <th className="px-4 py-3 text-left text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-gray-400">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {filteredAndSortedShows.map((show) => (
                <tr key={show.id} className="hover:bg-gray-700/50 transition">
                  <td className="px-4 py-4">
                    <Link href={`/show/${show.slug}`} className="block">
                      <div className="font-medium text-white hover:text-green-400 transition">
                        {show.title}
                      </div>
                      <div className="text-sm text-gray-400">{show.venue}</div>
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
                      <ScoreBadge score={show.criticScore?.score} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <ScoreBadge score={show.audienceScore?.score} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex justify-center">
                      <ScoreBadge score={show.buzzScore?.score} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <StatusChip status={show.status} />
                  </td>
                  <td className="px-4 py-4">
                    <ConfidenceBadge level={show.confidence?.level} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-4">
        {filteredAndSortedShows.map((show) => (
          <Link
            key={show.id}
            href={`/show/${show.slug}`}
            className="block bg-gray-800 rounded-lg p-4 hover:bg-gray-700/50 transition"
          >
            <div className="flex items-start gap-4">
              <ScoreBadge score={show.metascore} size="lg" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white">{show.title}</div>
                <div className="text-sm text-gray-400">{show.venue}</div>
                <div className="flex items-center gap-2 mt-2">
                  <StatusChip status={show.status} />
                  <ConfidenceBadge level={show.confidence?.level} />
                </div>
              </div>
            </div>
            <div className="flex justify-between mt-4 pt-4 border-t border-gray-700">
              <div className="text-center">
                <div className="text-xs text-gray-500 uppercase">Critics</div>
                <div className="font-bold text-white">{show.criticScore?.score ?? '—'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500 uppercase">Audience</div>
                <div className="font-bold text-white">{show.audienceScore?.score ?? '—'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500 uppercase">Buzz</div>
                <div className="font-bold text-white">{show.buzzScore?.score ?? '—'}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          No shows match your search.
        </div>
      )}

      <div className="mt-6 text-sm text-gray-500">
        Showing {filteredAndSortedShows.length} of {shows.length} shows
      </div>
    </div>
  );
}
