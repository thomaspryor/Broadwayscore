'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { CreativeProfile } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass, ordinalSuffix } from '@/lib/critic-page-utils';

type SortMode = 'recent' | 'highest' | 'lowest';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function ShowCard({ show, loading = 'lazy' }: { show: CreativeProfile['shows'][0]; loading?: 'eager' | 'lazy' }) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
        {show.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.thumbnail, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={56}
            height={56}
            loading={loading}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl">🎭</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate">
          {show.title}
        </h3>
        <p className="text-gray-400 text-xs sm:text-sm truncate">
          {show.venue}
          {show.openingDate && ` · ${formatDate(show.openingDate)}`}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-white/5 text-gray-400 border-white/10">
            {show.role}
          </span>
          {show.type && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
              show.type === 'musical'
                ? 'bg-purple-500/20 text-purple-400 border-purple-500/30'
                : 'bg-blue-500/20 text-blue-400 border-blue-500/30'
            }`}>
              {show.type === 'musical' ? 'Musical' : 'Play'}
            </span>
          )}
          {show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/30">
              Revival
            </span>
          )}
        </div>
      </div>

      {/* Score */}
      {show.score !== null ? (
        <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(show.score)} flex items-center justify-center font-bold flex-shrink-0`}>
          {Math.round(show.score)}
        </div>
      ) : (
        <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay flex items-center justify-center text-gray-500 font-bold flex-shrink-0">
          —
        </div>
      )}
    </Link>
  );
}

const INITIAL_SHOWS = 50;

export default function CreativeDetailClient({
  profile,
  categoryLabel,
  categoryLabelPlural,
  routePath,
  rank,
}: {
  profile: CreativeProfile;
  categoryLabel: string;
  categoryLabelPlural: string;
  routePath: string;
  rank: number;
}) {
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [showCount, setShowCount] = useState(INITIAL_SHOWS);

  const openShows = useMemo(() =>
    profile.shows.filter(s => s.status === 'open' || s.status === 'previews'),
    [profile.shows]
  );

  const closedShows = useMemo(() => {
    const closed = profile.shows.filter(s => s.status === 'closed');
    if (sortMode === 'highest') return [...closed].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    if (sortMode === 'lowest') return [...closed].sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
    return closed; // already sorted by date
  }, [profile.shows, sortMode]);

  const visibleClosed = closedShows.slice(0, showCount);
  const remaining = closedShows.length - showCount;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
        <ol className="flex items-center gap-1.5 flex-wrap">
          <li><Link href="/" className="hover:text-brand transition-colors">Home</Link></li>
          <li className="before:content-['/'] before:mx-1.5">
            <Link href={`/${routePath}`} className="hover:text-brand transition-colors">{categoryLabelPlural}</Link>
          </li>
          <li className="before:content-['/'] before:mx-1.5 text-gray-300 truncate" aria-current="page">{profile.name}</li>
        </ol>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">{profile.name}</h1>
        {profile.roles.length > 1 && (
          <p className="text-gray-400 text-sm mb-4">{profile.roles.join(', ')}</p>
        )}
        {profile.roles.length <= 1 && <div className="mb-4" />}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Shows</p>
            <p className="text-2xl font-bold text-white">{profile.showCount}</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Average</p>
            <p className={`text-2xl font-bold ${profile.avgScore !== null ? 'text-white' : 'text-gray-500'}`}>
              {profile.avgScore !== null ? Math.round(profile.avgScore) : '—'}
            </p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Highest</p>
            <p className={`text-2xl font-bold ${profile.highScore !== null ? 'text-white' : 'text-gray-500'}`}>
              {profile.highScore !== null ? Math.round(profile.highScore) : '—'}
            </p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Lowest</p>
            <p className={`text-2xl font-bold ${profile.lowScore !== null ? 'text-white' : 'text-gray-500'}`}>
              {profile.lowScore !== null ? Math.round(profile.lowScore) : '—'}
            </p>
          </div>
        </div>

        {/* Rank */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(rank)} most prolific {categoryLabel.toLowerCase()}</span>
        </div>
      </div>

      {/* Currently Running */}
      {openShows.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-3">
            Currently Running
            <span className="text-sm font-normal text-gray-400 ml-2">({openShows.length})</span>
          </h2>
          <div className="space-y-2">
            {openShows.map((show, i) => (
              <ShowCard key={show.slug} show={show} loading={i < 4 ? 'eager' : 'lazy'} />
            ))}
          </div>
        </section>
      )}

      {/* Past Productions */}
      {closedShows.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white">
              Past Productions
              <span className="text-sm font-normal text-gray-400 ml-2">({closedShows.length})</span>
            </h2>
            <div className="flex items-center gap-0.5 sm:gap-2" role="group" aria-label="Sort productions">
              <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
              {(['recent', 'highest', 'lowest'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSortMode(mode)}
                  className={`px-2 py-1 text-[11px] font-medium uppercase tracking-wider rounded transition-colors ${
                    sortMode === mode
                      ? 'text-brand bg-brand/10 sm:bg-transparent'
                      : 'text-gray-300 hover:text-white'
                  }`}
                >
                  {mode === 'recent' ? 'RECENT' : mode === 'highest' ? 'HIGHEST' : 'LOWEST'}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {visibleClosed.map((show, i) => (
              <ShowCard
                key={show.slug}
                show={show}
                loading={openShows.length === 0 && i < 4 ? 'eager' : 'lazy'}
              />
            ))}
          </div>

          {remaining > 0 && (
            <button
              onClick={() => setShowCount(prev => prev + 50)}
              className="w-full mt-4 py-3 text-sm font-medium text-brand hover:text-brand-hover border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
            >
              Show {Math.min(remaining, 50)} more ({remaining} remaining)
            </button>
          )}
        </section>
      )}

      {profile.showCount === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No shows found for {profile.name}.</p>
        </div>
      )}
    </div>
  );
}
