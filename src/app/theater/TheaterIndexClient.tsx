'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge, ToggleBar } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type StatusFilter = 'current' | 'all' | 'dark';
type SortMode = 'shows' | 'capacity' | 'score' | 'alpha';

interface TheaterSummary {
  name: string;
  slug: string;
  address?: string;
  showCount: number;
  capacity: number | null;
  currentShowTitle?: string;
  currentShowStatus?: 'open' | 'previews' | 'upcoming';
  avgScore: number | null;
}

function TheaterCard({ theater }: { theater: TheaterSummary }) {
  return (
    <Link
      href={`/theater/${theater.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Theater icon */}
      <div className="w-10 h-10 rounded-lg bg-surface-overlay flex items-center justify-center flex-shrink-0">
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
          {theater.name}
        </h2>
        <p className="text-gray-500 text-xs sm:text-sm truncate mt-0.5">
          {theater.currentShowTitle ? (
            <>
              <span className="text-brand">{theater.currentShowTitle}</span>
              {theater.currentShowStatus === 'previews' && (
                <span className="text-purple-400 text-[10px] font-medium ml-1.5">IN PREVIEWS</span>
              )}
              {theater.currentShowStatus === 'upcoming' && (
                <span className="text-blue-400 text-[10px] font-medium ml-1.5">UPCOMING</span>
              )}
            </>
          ) : (
            <span className="text-gray-600 italic">No current show</span>
          )}
        </p>
      </div>

      {/* Capacity — desktop only */}
      <div className="w-14 flex items-center justify-center flex-shrink-0 hidden sm:flex">
        <p className="text-sm font-medium text-gray-400">
          {theater.capacity ? theater.capacity.toLocaleString() : '—'}
        </p>
      </div>

      {/* Past show count */}
      <div className="w-10 sm:w-12 flex items-center justify-center flex-shrink-0">
        <p className="text-sm font-bold text-white">{theater.showCount}</p>
      </div>

      {/* Avg Critic Score */}
      <ScoreBadge score={theater.avgScore ?? undefined} size="sm" />
    </Link>
  );
}

export default function TheaterIndexClient({ theaters }: { theaters: TheaterSummary[] }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('current');
  const [sortMode, setSortMode] = useState<SortMode>('shows');

  const filtered = useMemo(() => {
    let list = theaters;

    // Status filter
    if (statusFilter === 'current') {
      list = list.filter(t => t.currentShowTitle);
    } else if (statusFilter === 'dark') {
      list = list.filter(t => !t.currentShowTitle);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.currentShowTitle && t.currentShowTitle.toLowerCase().includes(q)) ||
        (t.address && t.address.toLowerCase().includes(q))
      );
    }

    return list;
  }, [search, theaters, statusFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'shows': return list.sort((a, b) => b.showCount - a.showCount);
      case 'capacity': return list.sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0));
      case 'score': return list.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
      case 'alpha': return list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [filtered, sortMode]);

  const playingCount = theaters.filter(t => t.currentShowTitle).length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Theaters' },
      ]} />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Broadway Theaters</h1>
        <p className="text-gray-400">
          {theaters.length} theaters · {playingCount} with shows currently running
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-4" role="search">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          aria-label="Search theaters or shows"
          placeholder="Search theaters or shows..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
        />
      </div>

      {/* Status & Sort — matching homepage pattern */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <ToggleBar
          label="STATUS:"
          options={[
            { value: 'current' as StatusFilter, label: 'PLAYING' },
            { value: 'all' as StatusFilter, label: 'ALL' },
            { value: 'dark' as StatusFilter, label: 'DARK' },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
          ariaLabel="Filter by theater status"
        />
        <ToggleBar
          label="SORT:"
          options={[
            { value: 'shows' as SortMode, label: 'MOST SHOWS' },
            { value: 'capacity' as SortMode, label: 'CAPACITY' },
            { value: 'score' as SortMode, label: 'SCORE' },
            { value: 'alpha' as SortMode, label: 'A-Z' },
          ]}
          value={sortMode}
          onChange={setSortMode}
          ariaLabel="Sort theaters"
        />
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2">
        <div className="w-10 flex-shrink-0" />
        <div className="flex-1 min-w-0" />
        <div className="w-14 hidden sm:flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Seats</span>
        </div>
        <div className="w-10 sm:w-12 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Past</span>
        </div>
        <div className="w-10 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Score</span>
        </div>
      </div>

      {/* Theater List */}
      <div className="space-y-2">
        {sorted.map(t => <TheaterCard key={t.slug} theater={t} />)}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No theaters match{search.trim() ? ` "${search}"` : ' your filters'}</p>
        </div>
      )}

      {sorted.length > 0 && (
        <p className="text-center text-sm text-gray-500 mt-6">
          {sorted.length} theater{sorted.length !== 1 ? 's' : ''}
          {search.trim() ? ` matching "${search}"` : ''}
        </p>
      )}
    </div>
  );
}
