'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge, FormatPill, ProductionPill, ToggleBar, ScoreToggle } from '@/components/show-cards';
import { getBroadwayDuration } from '@/lib/date-utils';

export interface TheaterShow {
  id: string;
  slug: string;
  title: string;
  openingDate: string;
  closingDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number };
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
}

type ScoreMode = 'critics' | 'audience';
type SortMode = 'newest' | 'highest' | 'alpha';


export default function TheaterDetailClient({ shows }: { shows: TheaterShow[] }) {
  const [scoreMode, setScoreMode] = useState<ScoreMode>('critics');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [typeFilter, setTypeFilter] = useState<'all' | 'musical' | 'play'>('all');

  const hasAnyAudienceData = useMemo(
    () => shows.some(s => s.audienceCombinedScore !== null),
    [shows]
  );

  const isMixedType = useMemo(() => {
    const types = new Set(shows.map(s => s.type));
    return types.size > 1;
  }, [shows]);

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return shows;
    return shows.filter(s => s.type === typeFilter);
  }, [shows, typeFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sortMode) {
      case 'newest':
        return list.sort((a, b) => new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime());
      case 'highest': {
        const getScore = (s: TheaterShow) =>
          scoreMode === 'audience' ? (s.audienceCombinedScore ?? -1) : (s.criticScore?.score ?? -1);
        return list.sort((a, b) => getScore(b) - getScore(a));
      }
      case 'alpha':
        return list.sort((a, b) => a.title.localeCompare(b.title));
    }
  }, [filtered, sortMode, scoreMode]);

  return (
    <div>
      {/* Single row: type pills (left) + sort + toggle (right) */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Type filter */}
          {isMixedType && (
            <ToggleBar
              variant="pill"
              options={[{ value: 'all' as const, label: 'All' }, { value: 'musical' as const, label: 'Musicals' }, { value: 'play' as const, label: 'Plays' }]}
              value={typeFilter}
              onChange={setTypeFilter}
              ariaLabel="Filter by type"
            />
          )}

          {/* Sort */}
          <ToggleBar
            label="Sort:"
            options={[
              { value: 'newest' as SortMode, label: 'Newest' },
              { value: 'highest' as SortMode, label: 'Highest' },
              { value: 'alpha' as SortMode, label: 'A-Z' },
            ]}
            value={sortMode}
            onChange={setSortMode}
            ariaLabel="Sort shows"
          />
        </div>

        {/* Critics/Audience toggle */}
        {hasAnyAudienceData && (
          <ScoreToggle
            value={scoreMode}
            onChange={(key) => {
              setScoreMode(key);
              if (key === 'audience') setSortMode('highest');
            }}
          />
        )}
      </div>

      {/* Show list */}
      <div className="space-y-2">
        {sorted.map(show => {
          const isOpen = show.status === 'open' || show.status === 'previews' || show.status === 'upcoming';
          const displayScore = scoreMode === 'audience'
            ? (show.audienceCombinedScore ?? undefined)
            : show.criticScore?.score;

          return (
            <Link
              key={show.id}
              href={`/show/${show.slug}`}
              className={`card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group ${
                isOpen ? 'border border-status-open/20' : ''
              }`}
            >
              <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                {show.images?.thumbnail ? (
                  <img src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')} alt={show.title} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><span className="text-lg sm:text-xl">🎭</span></div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate text-sm sm:text-base">{show.title}</h3>
                  {isOpen && <span className="w-1.5 h-1.5 rounded-full bg-status-open flex-shrink-0" />}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-xs text-gray-500">
                  <FormatPill type={show.type} />
                  {show.isRevival && <ProductionPill isRevival={true} />}
                  {isOpen ? (() => {
                    const duration = getBroadwayDuration(show.openingDate);
                    return <>
                      {duration && (
                        <span>{duration}</span>
                      )}
                      {show.closingDate && (
                        <span className="text-amber-400">
                          · Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </>;
                  })() : (
                    <span>
                      {show.openingDate ? new Date(show.openingDate).getFullYear() : ''}
                      {show.closingDate && show.openingDate ? ` – ${new Date(show.closingDate).getFullYear()}` : show.closingDate ? new Date(show.closingDate).getFullYear() : ''}
                    </span>
                  )}
                </div>
              </div>
              <ScoreBadge score={displayScore} size="sm" showCrown status={show.status} />
            </Link>
          );
        })}
      </div>

      {sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No shows match the current filter.</p>
        </div>
      )}

      <p className="text-center text-sm text-gray-500 mt-6">
        {sorted.length} show{sorted.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
