'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AwardScoreBadge, AWARD_TIER_LABEL } from '@/components/show-cards/AwardScoreBadge';
import { StatusBadge } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';
import type { SlimAwardScore } from '@/lib/award-notable-win';

type SortDirection = 'asc' | 'desc';
type SortColumn = 'show' | 'score';

export interface ShowAwardData {
  show: {
    slug: string;
    title: string;
    status?: string;
    images?: { hero?: string; thumbnail?: string; poster?: string };
  };
  awardScore: SlimAwardScore;
}

const TIER_CHIP: Record<string, string> = {
  sweeper:       'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  decorated:     'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  honored:       'bg-teal-600/20 text-teal-400 border border-teal-500/30',
  nominated:     'bg-amber-900/40 text-amber-200 border border-amber-700/30',
  'in-the-hunt': 'bg-amber-600/30 text-amber-300 border border-amber-600/30',
  eligible:      'bg-white/5 text-gray-400 border border-white/10',
};

function formatSeason(season: string): string {
  const m = season.match(/^(\d{4})-(\d{4})$/);
  if (!m) return season;
  return `${m[1]}–${m[2].slice(2)}`;
}

function toSeasonSlug(fullSeason: string): string {
  const m = fullSeason.match(/^(\d{4})-\d{2}(\d{2})$/);
  if (!m) return fullSeason;
  return `${m[1]}-${m[2]}`;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) return <span className="ml-1 text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity">↕</span>;
  return <span className="ml-1 text-brand">{direction === 'asc' ? '↑' : '↓'}</span>;
}

interface SortableAwardScoreTableProps {
  data: ShowAwardData[];
  /** Server-render only this many rows; the full table renders right after hydration
   *  (the 1,300-row table was 3.5MB of HTML, past Googlebot's 2MB limit, BRO-5968). */
  initialRenderLimit?: number;
}

export function SortableAwardScoreTable({ data, initialRenderLimit }: SortableAwardScoreTableProps) {
  const [fullTableReady, setFullTableReady] = useState(initialRenderLimit === undefined);
  useEffect(() => setFullTableReady(true), []);
  const router = useRouter();
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [seasonFilter, setSeasonFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const seasons = useMemo(() => {
    const seen = new Set<string>();
    for (const item of data) {
      if (item.awardScore.tonySeason) seen.add(item.awardScore.tonySeason);
    }
    return Array.from(seen).sort().reverse();
  }, [data]);

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection(col === 'show' ? 'asc' : 'desc');
    }
  };

  const sortedData = useMemo(() => {
    let filtered = data;
    if (seasonFilter !== 'all') {
      filtered = filtered.filter(item => item.awardScore.tonySeason === seasonFilter);
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter(item => item.show.status === statusFilter);
    }
    return [...filtered].sort((a, b) => {
      if (sortColumn === 'show') {
        const cmp = a.show.title.toLowerCase().localeCompare(b.show.title.toLowerCase());
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      const diff = (a.awardScore.displayScore ?? 0) - (b.awardScore.displayScore ?? 0);
      return sortDirection === 'asc' ? diff : -diff;
    });
  }, [data, sortColumn, sortDirection, seasonFilter, statusFilter]);

  const selectClass = 'text-sm bg-surface-overlay border border-white/10 text-gray-300 rounded-lg px-3 py-1.5 cursor-pointer hover:border-white/20 transition-colors focus:outline-none focus:ring-1 focus:ring-brand/50';
  const thClass = 'py-3 px-4 text-gray-400 font-medium text-center cursor-pointer hover:text-white transition-colors select-none group';

  return (
    <div className="card overflow-hidden">
      {/* Filters — always show status filter; season filter only when multiple seasons in data */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/10 bg-surface-overlay/50">
        <span className="text-xs text-fg-muted font-medium uppercase tracking-wide">Filter</span>
        {seasons.length > 1 && (
          <select
            value={seasonFilter}
            onChange={e => setSeasonFilter(e.target.value)}
            className={selectClass}
            aria-label="Filter by season"
          >
            <option value="all">All Seasons</option>
            {seasons.map(s => (
              <option key={s} value={s}>{formatSeason(s)}</option>
            ))}
          </select>
        )}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className={selectClass}
          aria-label="Filter by status"
        >
          <option value="all">All Shows</option>
          <option value="open">Now Playing</option>
          <option value="previews">In Previews</option>
          <option value="closed">Closed</option>
        </select>
        {(seasonFilter !== 'all' || statusFilter !== 'all') && (
          <button
            onClick={() => { setSeasonFilter('all'); setStatusFilter('all'); }}
            className="text-xs text-fg-muted hover:text-gray-300 transition-colors"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-fg-muted">{sortedData.length} show{sortedData.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-center py-3 pl-4 pr-2 text-gray-400 font-medium w-10 hidden sm:table-cell">#</th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group" onClick={() => handleSort('show')}>
                Show
                <SortIcon active={sortColumn === 'show'} direction={sortDirection} />
              </th>
              <th className={thClass} onClick={() => handleSort('score')}>
                Award Score
                <SortIcon active={sortColumn === 'score'} direction={sortDirection} />
              </th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Tier</th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Notable</th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden md:table-cell">Tony Record</th>
            </tr>
          </thead>
          <tbody>
            {(fullTableReady ? sortedData : sortedData.slice(0, initialRenderLimit)).map((item, index) => {
              const { awardScore, show } = item;
              const notableWin = awardScore.notableWin;

              // Always show both wins and noms so columns are consistent across all seasons
              const hasTonyActivity = awardScore.tonyWins > 0 || awardScore.tonyNoms > 0;
              const tonyRecord = hasTonyActivity
                ? `${awardScore.tonyWins} Win${awardScore.tonyWins !== 1 ? 's' : ''} · ${awardScore.tonyNoms} Nom${awardScore.tonyNoms !== 1 ? 's' : ''}`
                : '–';

              const posterUrl = show.images?.poster ?? show.images?.thumbnail ?? show.images?.hero;
              const optimizedUrl = posterUrl ? getOptimizedImageUrl(posterUrl, 'thumbnail') : undefined;

              return (
                <tr key={show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  {/* Rank */}
                  <td className="py-3 pl-4 pr-2 text-center align-middle hidden sm:table-cell">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-fg-muted'
                    }`}>
                      {index + 1}
                    </span>
                  </td>

                  {/* Show */}
                  <td className="py-3 px-4 align-middle">
                    <div className="flex items-center gap-3">
                      {/* Thumbnail */}
                      <Link href={`/show/${show.slug}`} className="shrink-0" tabIndex={-1} aria-hidden>
                        <div className="w-10 h-14 rounded overflow-hidden bg-surface-overlay">
                          <ShowImage
                            sizes="40px"
                            sources={[optimizedUrl, posterUrl]}
                            alt=""
                            ariaHidden
                            className="w-full h-full object-cover"
                            width={40}
                            height={56}
                            loading="lazy"
                            fallback={
                              <div className="w-full h-full flex items-center justify-center text-fg-muted text-lg">🎭</div>
                            }
                          />
                        </div>
                      </Link>
                      <div className="min-w-0">
                        <Link href={`/show/${show.slug}`} className="text-white hover:text-brand transition-colors font-medium leading-tight block">
                          {show.title}
                        </Link>
                        <div className="mt-1 sm:hidden">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${TIER_CHIP[awardScore.badge] ?? TIER_CHIP.eligible}`}>
                            {AWARD_TIER_LABEL[awardScore.badge]}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {show.status && <StatusBadge status={show.status} />}
                          {awardScore.tonySeason && (
                            <span className="text-xs text-fg-muted">{formatSeason(awardScore.tonySeason)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Award Score */}
                  <td className="py-3 px-4 text-center align-middle">
                    <div className="flex justify-center">
                      <AwardScoreBadge
                        score={awardScore.displayScore}
                        badge={awardScore.badge}
                        inProgress={awardScore.inProgress}
                        size="md"
                      />
                    </div>
                  </td>

                  {/* Tier */}
                  <td className="py-3 px-4 text-center align-middle hidden sm:table-cell">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${TIER_CHIP[awardScore.badge] ?? TIER_CHIP.eligible}`}>
                      {AWARD_TIER_LABEL[awardScore.badge]}
                    </span>
                  </td>

                  {/* Notable */}
                  <td className="py-3 px-4 text-center align-middle hidden lg:table-cell">
                    {notableWin
                      ? <span className="text-amber-300 text-xs font-medium">{notableWin}</span>
                      : <span className="text-fg-muted">–</span>
                    }
                  </td>

                  {/* Tony Record */}
                  <td className="py-3 px-4 text-center align-middle hidden md:table-cell">
                    <span className="text-gray-400 text-sm tabular-nums">{tonyRecord}</span>
                  </td>
                </tr>
              );
            })}
            {sortedData.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-fg-muted text-sm">
                  No shows match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
