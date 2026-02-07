'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass } from '@/lib/critic-page-utils';

type SortMode = 'shows' | 'highest' | 'lowest' | 'alpha';

interface DirectorSummary {
  name: string;
  slug: string;
  showCount: number;
  avgScore: number | null;
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'shows', label: 'MOST SHOWS' },
  { value: 'highest', label: 'HIGHEST AVG' },
  { value: 'lowest', label: 'LOWEST AVG' },
  { value: 'alpha', label: 'A-Z' },
];

function DirectorCard({ director }: { director: DirectorSummary }) {
  return (
    <Link
      href={`/director/${director.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-sm">
          {director.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
          {director.name}
        </h2>
        <p className="text-gray-500 text-xs sm:text-sm mt-0.5">
          {director.showCount} {director.showCount === 1 ? 'show' : 'shows'}
        </p>
      </div>

      {/* Show count */}
      <div className="w-12 sm:w-14 text-center flex-shrink-0">
        <p className="text-lg font-bold text-white">{director.showCount}</p>
      </div>

      {/* Avg Score */}
      <div className="w-10 flex-shrink-0">
        {director.avgScore != null ? (
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(director.avgScore)} flex items-center justify-center font-bold`}>
            {Math.round(director.avgScore)}
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

export default function DirectorIndexClient({ directors }: { directors: DirectorSummary[] }) {
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('shows');

  const filtered = useMemo(() => {
    if (!search.trim()) return directors;
    const q = search.toLowerCase();
    return directors.filter(d => d.name.toLowerCase().includes(q));
  }, [search, directors]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'shows': return list.sort((a, b) => b.showCount - a.showCount);
      case 'highest': return list.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
      case 'lowest': return list.sort((a, b) => (a.avgScore ?? 999) - (b.avgScore ?? 999));
      case 'alpha': return list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [filtered, sortMode]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300" aria-current="page">Directors</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Broadway Directors</h1>
        <p className="text-gray-400">
          {directors.length} directors with shows in our database
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search directors..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface-overlay border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-brand/50"
        />
      </div>

      {/* Sort Controls */}
      <div className="flex items-center gap-0.5 sm:gap-2 flex-wrap mb-5" role="group" aria-label="Sort directors">
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
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Avg</span>
        </div>
      </div>

      {/* Director List */}
      <div className="space-y-2">
        {sorted.map(d => <DirectorCard key={d.slug} director={d} />)}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No directors match &quot;{search}&quot;</p>
        </div>
      )}

      {sorted.length > 0 && (
        <p className="text-center text-sm text-gray-500 mt-6">
          {sorted.length} director{sorted.length !== 1 ? 's' : ''}
          {search.trim() ? ` matching "${search}"` : ''}
        </p>
      )}
    </div>
  );
}
