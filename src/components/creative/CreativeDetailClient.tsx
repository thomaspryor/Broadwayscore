'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { CreativeProfile } from '@/lib/data-types';
import { ordinalSuffix } from '@/lib/critic-page-utils';
import { ToggleBar, StatGrid } from '@/components/show-cards';
import { CreativeShowCard } from './CreativeShowCard';
import Breadcrumb from '@/components/Breadcrumb';

type SortMode = 'recent' | 'highest' | 'lowest';

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
    profile.shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming'),
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
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: categoryLabelPlural, href: `/${routePath}` },
        { label: profile.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">{profile.name}</h1>
        {profile.roles.length > 1 && (
          <p className="text-gray-400 text-sm mb-4">{profile.roles.join(', ')}</p>
        )}
        {profile.roles.length <= 1 && <div className="mb-4" />}

        {/* Stats */}
        <StatGrid className="mb-4" stats={[
          { label: 'Shows', value: profile.showCount },
          { label: 'Avg Score', value: profile.avgScore !== null ? Math.round(profile.avgScore) : '—', dimmed: profile.avgScore === null },
          { label: 'Highest', value: profile.highScore !== null ? Math.round(profile.highScore) : '—', dimmed: profile.highScore === null },
          { label: 'Lowest', value: profile.lowScore !== null ? Math.round(profile.lowScore) : '—', dimmed: profile.lowScore === null },
        ]} />

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
              <CreativeShowCard key={show.slug} show={show} roles={[show.role]} loading={i < 4 ? 'eager' : 'lazy'} />
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
            <ToggleBar
              label="SORT:"
              options={[
                { value: 'recent' as SortMode, label: 'RECENT' },
                { value: 'highest' as SortMode, label: 'HIGHEST' },
                { value: 'lowest' as SortMode, label: 'LOWEST' },
              ]}
              value={sortMode}
              onChange={setSortMode}
              ariaLabel="Sort productions"
              size="compact"
            />
          </div>
          <div className="space-y-2">
            {visibleClosed.map((show, i) => (
              <CreativeShowCard
                key={show.slug}
                show={show}
                roles={[show.role]}
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
