'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass } from '@/lib/critic-page-utils';

type SortMode = 'shows' | 'alpha' | 'playing';

interface TheaterSummary {
  name: string;
  slug: string;
  address?: string;
  showCount: number;
  currentShowTitle?: string;
  currentShowSlug?: string;
  currentShowScore?: number | null;
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'playing', label: 'NOW PLAYING' },
  { value: 'shows', label: 'MOST SHOWS' },
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

      {/* Show count */}
      <div className="w-12 sm:w-14 text-center flex-shrink-0">
        <p className="text-lg font-bold text-white">{theater.showCount}</p>
      </div>

      {/* Score */}
      <div className="w-10 flex-shrink-0">
        {theater.currentShowScore != null ? (
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(theater.currentShowScore)} flex items-center justify-center font-bold`}>
            {Math.round(theater.currentShowScore)}
          </div>
        ) : (
          <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay text-gray-600 border border-white/5 flex items-center justify-center font-bold">
            —
          </div>
        )}
      </div>
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
          // Theaters with current shows first, then by show count
          const aPlaying = a.currentShowTitle ? 1 : 0;
          const bPlaying = b.currentShowTitle ? 1 : 0;
          if (bPlaying !== aPlaying) return bPlaying - aPlaying;
          return b.showCount - a.showCount;
        });
      case 'shows': return list.sort((a, b) => b.showCount - a.showCount);
      case 'alpha': return list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [filtered, sortMode]);

  const playingCount = theaters.filter(t => t.currentShowTitle).length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300" aria-current="page">Theaters</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Broadway Theaters</h1>
        <p className="text-gray-400">
          {theaters.length} theaters · {playingCount} with shows currently running
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search theaters or shows..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
        />
      </div>

      {/* Sort Controls */}
      <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap mb-5" role="group" aria-label="Sort theaters">
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
        {SORT_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setSortMode(opt.value)}
            className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
              sortMode === opt.value
                ? 'text-brand bg-brand/10 sm:bg-transparent'
                : 'text-gray-300 hover:text-white'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Column Headers */}
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-4 mb-2">
        <div className="w-10 flex-shrink-0" />
        <div className="flex-1 min-w-0" />
        <div className="w-12 sm:w-14 text-center flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Shows</span>
        </div>
        <div className="w-10 text-center flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Score</span>
        </div>
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
