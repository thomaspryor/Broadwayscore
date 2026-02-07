'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getScoreClass } from '@/lib/critic-page-utils';

type SortMode = 'shows' | 'highest' | 'lowest' | 'alpha';

interface CreativeProfileSummary {
  name: string;
  slug: string;
  showCount: number;
  avgScore: number | null;
  openShowCount: number;
  roles: string[];
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'shows', label: 'MOST SHOWS' },
  { value: 'highest', label: 'HIGHEST AVG' },
  { value: 'lowest', label: 'LOWEST AVG' },
  { value: 'alpha', label: 'A-Z' },
];

function ProfileCard({ profile, routePath }: { profile: CreativeProfileSummary; routePath: string }) {
  return (
    <Link
      href={`/${routePath}/${profile.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
        <span className="text-white font-bold text-sm">
          {profile.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">
          {profile.name}
        </h2>
        <p className="text-gray-400 text-xs sm:text-sm">
          {profile.showCount} show{profile.showCount !== 1 ? 's' : ''}
          {profile.openShowCount > 0 && (
            <span className="text-emerald-400"> · {profile.openShowCount} running</span>
          )}
        </p>
      </div>

      {/* Show count */}
      <div className="w-14 text-right flex-shrink-0">
        <p className="text-lg font-bold text-white">{profile.showCount}</p>
      </div>

      {/* Avg Score */}
      <div className="w-11 flex-shrink-0">
        {profile.avgScore !== null ? (
          <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(profile.avgScore)} flex items-center justify-center font-bold`}>
            {Math.round(profile.avgScore)}
          </div>
        ) : (
          <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay flex items-center justify-center text-gray-500 font-bold">
            —
          </div>
        )}
      </div>
    </Link>
  );
}

export default function CreativeIndexClient({
  profiles,
  categoryLabel,
  routePath,
  totalShows,
}: {
  profiles: CreativeProfileSummary[];
  categoryLabel: string;
  routePath: string;
  totalShows: number;
}) {
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('shows');

  const filtered = useMemo(() => {
    if (!search) return profiles;
    const q = search.toLowerCase();
    return profiles.filter(p => p.name.toLowerCase().includes(q));
  }, [search, profiles]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'highest':
        return list.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
      case 'lowest':
        return list.sort((a, b) => (a.avgScore ?? 999) - (b.avgScore ?? 999));
      case 'alpha':
        return list.sort((a, b) => a.name.localeCompare(b.name));
      default:
        return list.sort((a, b) => b.showCount - a.showCount);
    }
  }, [filtered, sortMode]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5 flex-wrap">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300" aria-current="page">{categoryLabel}</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">Broadway {categoryLabel}</h1>
        <p className="text-gray-400 text-sm">
          {profiles.length} {categoryLabel.toLowerCase()} across {totalShows} Broadway shows
        </p>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder={`Search ${categoryLabel.toLowerCase()}...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-surface-overlay border border-white/10 rounded-lg px-4 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-brand/50"
        />
        <div className="flex gap-1">
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setSortMode(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortMode === opt.value
                  ? 'bg-brand/20 text-brand border border-brand/30'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      {sorted.length > 0 ? (
        <div className="space-y-2">
          {sorted.map(profile => (
            <ProfileCard key={profile.slug} profile={profile} routePath={routePath} />
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No {categoryLabel.toLowerCase()} found matching &ldquo;{search}&rdquo;</p>
        </div>
      )}
    </div>
  );
}
