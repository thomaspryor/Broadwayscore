'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

type SortMode = 'playing' | 'shows' | 'capacity' | 'score' | 'alpha';

interface TheaterSummary {
  name: string;
  slug: string;
  address?: string;
  showCount: number;
  capacity: number | null;
  currentShowTitle?: string;
  avgScore: number | null;
}

// Pill-style sorts (left side of header row)
const PILL_SORTS: { value: SortMode; label: string }[] = [
  { value: 'playing', label: 'Playing' },
  { value: 'alpha', label: 'A-Z' },
];

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
            <span className="text-brand">{theater.currentShowTitle}</span>
          ) : (
            <span className="text-gray-600 italic">No current show</span>
          )}
        </p>
      </div>

      {/* Capacity — desktop only */}
      <div className="w-14 text-center flex-shrink-0 hidden sm:block">
        <p className="text-sm font-medium text-gray-400">
          {theater.capacity ? theater.capacity.toLocaleString() : '—'}
        </p>
      </div>

      {/* Show count */}
      <div className="w-10 sm:w-12 text-center flex-shrink-0">
        <p className="text-sm font-bold text-white">{theater.showCount}</p>
      </div>

      {/* Avg Score */}
      <ScoreBadge score={theater.avgScore ?? undefined} size="sm" />
    </Link>
  );
}

export default function TheaterIndexClient({ theaters }: { theaters: TheaterSummary[] }) {
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('playing');

  const filtered = useMemo(() => {
    if (!search.trim()) return theaters;
    const q = search.toLowerCase();
    return theaters.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.currentShowTitle && t.currentShowTitle.toLowerCase().includes(q)) ||
      (t.address && t.address.toLowerCase().includes(q))
    );
  }, [search, theaters]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'playing':
        return list.sort((a, b) => {
          const aPlaying = a.currentShowTitle ? 1 : 0;
          const bPlaying = b.currentShowTitle ? 1 : 0;
          if (bPlaying !== aPlaying) return bPlaying - aPlaying;
          return b.showCount - a.showCount;
        });
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

      {/* Combined sort pills + clickable column headers */}
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2">
        {/* Pill sorts on the left */}
        <div className="w-10 flex-shrink-0" />
        <div className="flex-1 min-w-0 flex items-center gap-0.5" role="group" aria-label="Sort theaters">
          {PILL_SORTS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setSortMode(opt.value)}
              aria-pressed={sortMode === opt.value}
              className={`px-2 py-1 rounded-full text-[10px] font-semibold uppercase transition-colors min-h-[28px] whitespace-nowrap ${
                sortMode === opt.value
                  ? 'bg-white/15 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Clickable column headers on the right */}
        <button
          onClick={() => setSortMode('capacity')}
          aria-pressed={sortMode === 'capacity'}
          aria-label="Sort by seat capacity"
          className={`w-14 text-center flex-shrink-0 hidden sm:block cursor-pointer transition-colors ${
            sortMode === 'capacity' ? 'text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider">Seats{sortMode === 'capacity' ? ' ↓' : ''}</span>
        </button>
        <button
          onClick={() => setSortMode('shows')}
          aria-pressed={sortMode === 'shows'}
          aria-label="Sort by show count"
          className={`w-10 sm:w-12 text-center flex-shrink-0 cursor-pointer transition-colors ${
            sortMode === 'shows' ? 'text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider">Shows{sortMode === 'shows' ? ' ↓' : ''}</span>
        </button>
        <button
          onClick={() => setSortMode('score')}
          aria-pressed={sortMode === 'score'}
          aria-label="Sort by average score"
          className={`w-10 text-center flex-shrink-0 cursor-pointer transition-colors ${
            sortMode === 'score' ? 'text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider">Avg{sortMode === 'score' ? ' ↓' : ''}</span>
        </button>
      </div>

      {/* Theater List */}
      <div className="space-y-2">
        {sorted.map(t => <TheaterCard key={t.slug} theater={t} />)}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No theaters match &quot;{search}&quot;</p>
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
