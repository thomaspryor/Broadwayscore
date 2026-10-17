'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { UnifiedCreativeProfile } from '@/lib/data-types';
import type { PersonTonyStats, ShowTonyInfo } from '@/lib/data-tony-noms';
import { ordinalSuffix } from '@/lib/critic-page-utils';
import { ToggleBar, StatGrid } from '@/components/show-cards';
import { CreativeShowCard } from './CreativeShowCard';
import Breadcrumb from '@/components/Breadcrumb';

type SortMode = 'recent' | 'highest' | 'lowest';

const INITIAL_SHOWS = 50;

export default function UnifiedCreativeDetailClient({
  profile,
  categoryLabels,
  rank,
  tonyStats,
  tonyByShow,
}: {
  profile: UnifiedCreativeProfile;
  categoryLabels: string[];
  rank: number;
  tonyStats: PersonTonyStats | null;
  tonyByShow: Record<string, ShowTonyInfo>;
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
        { label: 'Creative Team', href: '/directors' },
        { label: profile.name },
      ]} />

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">{profile.name}</h1>

        {/* Category badges */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {categoryLabels.map(label => (
            <span key={label} className="text-xs font-medium px-2.5 py-1 rounded-full border bg-brand/10 text-brand border-brand/30">
              {label}
            </span>
          ))}
        </div>

        {/* Stats — only show score stats when 2+ scored shows */}
        <StatGrid className="mb-4" stats={[
          { label: 'Shows', value: profile.showCount, subValue: profile.scoredShowCount > 0 && profile.scoredShowCount < profile.showCount ? `${profile.scoredShowCount} scored` : undefined },
          ...(tonyStats ? [{
            label: 'Tonys',
            value: (tonyStats.wins > 0 ? `${tonyStats.wins} win${tonyStats.wins !== 1 ? 's' : ''}` : `${tonyStats.nominations} nom${tonyStats.nominations !== 1 ? 's' : ''}`) as string | number,
            subValue: tonyStats.wins > 0 ? `${tonyStats.nominations} nom${tonyStats.nominations !== 1 ? 's' : ''}` : undefined,
            subValueColor: '#fbbf24',
          }] : []),
          ...(profile.scoredShowCount >= 2 ? [
            { label: 'Avg Score', value: profile.avgScore !== null ? Math.round(profile.avgScore) : '—' as string | number, dimmed: profile.avgScore === null },
            { label: 'Highest', value: profile.highScore !== null ? Math.round(profile.highScore) : '—' as string | number, dimmed: profile.highScore === null },
            { label: 'Lowest', value: profile.lowScore !== null ? Math.round(profile.lowScore) : '—' as string | number, dimmed: profile.lowScore === null },
          ] : profile.scoredShowCount === 1 ? [
            { label: 'Score', value: profile.avgScore !== null ? Math.round(profile.avgScore) : '—' as string | number, dimmed: profile.avgScore === null, subtitle: '1 scored show' },
          ] : []),
        ]} />

        {/* Rank */}
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <span>{ordinalSuffix(rank)} most prolific creative team member</span>
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
              <CreativeShowCard key={show.slug} show={show} roles={show.roles} loading={i < 4 ? 'eager' : 'lazy'} tonyInfo={tonyByShow[show.showId]} />
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
                roles={show.roles}
                loading={openShows.length === 0 && i < 4 ? 'eager' : 'lazy'}
                tonyInfo={tonyByShow[show.showId]}
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
