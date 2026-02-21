'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { TrophyIcon } from '@/components/icons';
import { ToggleBar } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';
import type { LeaderboardRow } from './page';

type FilterMode = 'all' | 'acting' | 'creative';

const INITIAL_COUNT = 50;

function abbreviateCategory(cat: string): string {
  // "Best Actress in a Musical" → "Actress (Musical)"
  // "Best Scenic Design of a Play" → "Scenic Design (Play)"
  // "Best Original Score" → "Original Score"
  let s = cat.replace('Best ', '');
  if (s.includes(' in a Musical')) return s.replace(' in a Musical', '') + ' (Musical)';
  if (s.includes(' in a Play')) return s.replace(' in a Play', '') + ' (Play)';
  if (s.includes(' of a Musical')) return s.replace(' of a Musical', '') + ' (Musical)';
  if (s.includes(' of a Play')) return s.replace(' of a Play', '') + ' (Play)';
  return s;
}

export default function TonyLeaderboardClient({
  rows,
  totalNominations,
  totalWins,
  coverage,
}: {
  rows: LeaderboardRow[];
  totalNominations: number;
  totalWins: number;
  coverage: string;
}) {
  const [filter, setFilter] = useState<FilterMode>('all');
  const [showCount, setShowCount] = useState(INITIAL_COUNT);

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'acting') {
      return rows
        .filter(r => r.actingNominations > 0)
        .map(r => ({ ...r, wins: r.actingWins, nominations: r.actingNominations }))
        .sort((a, b) => b.wins - a.wins || b.nominations - a.nominations);
    }
    // creative = non-acting
    return rows
      .filter(r => r.nominations - r.actingNominations > 0)
      .map(r => ({
        ...r,
        wins: r.wins - r.actingWins,
        nominations: r.nominations - r.actingNominations,
      }))
      .sort((a, b) => b.wins - a.wins || b.nominations - a.nominations);
  }, [rows, filter]);

  const visible = filtered.slice(0, showCount);
  const remaining = filtered.length - showCount;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Tony Awards', href: '/tony-awards' },
        { label: 'People' },
      ]} />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
          <TrophyIcon className="w-7 h-7 text-yellow-400" />
          Tony Awards Leaderboard
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          All-time Tony Award winners and nominees ({coverage}). {totalWins.toLocaleString()} wins across {totalNominations.toLocaleString()} nominations.
        </p>
      </div>

      {/* Filter */}
      <div className="mb-4">
        <ToggleBar
          label="SHOW:"
          options={[
            { value: 'all' as FilterMode, label: 'ALL' },
            { value: 'acting' as FilterMode, label: 'ACTING' },
            { value: 'creative' as FilterMode, label: 'CREATIVE' },
          ]}
          value={filter}
          onChange={(v: FilterMode) => { setFilter(v); setShowCount(INITIAL_COUNT); }}
          ariaLabel="Filter by category type"
          size="compact"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide border-b border-white/10">
              <th className="pb-2 pr-2 w-8 text-center">#</th>
              <th className="pb-2 pr-3">Name</th>
              <th className="pb-2 pr-3 text-center w-16">Wins</th>
              <th className="pb-2 pr-3 text-center w-16">Noms</th>
              <th className="pb-2 hidden sm:table-cell">Categories</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={row.ibdbPersonId || row.name} className="border-b border-white/5 hover:bg-white/[0.02]">
                <td className="py-2.5 pr-2 text-center text-xs text-gray-500 tabular-nums">{i + 1}</td>
                <td className="py-2.5 pr-3">
                  {row.profileUrl ? (
                    <Link href={row.profileUrl} className="text-sm font-medium text-white hover:text-brand transition-colors">
                      {row.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-gray-300">{row.name}</span>
                  )}
                  <span className="text-[10px] text-gray-500 ml-1.5 hidden sm:inline">
                    {row.showCount} show{row.showCount !== 1 ? 's' : ''}
                  </span>
                </td>
                <td className="py-2.5 pr-3 text-center">
                  {row.wins > 0 ? (
                    <span className="text-sm font-bold text-yellow-300 tabular-nums">{row.wins}</span>
                  ) : (
                    <span className="text-sm text-gray-600 tabular-nums">0</span>
                  )}
                </td>
                <td className="py-2.5 pr-3 text-center">
                  <span className="text-sm text-gray-400 tabular-nums">{row.nominations}</span>
                </td>
                <td className="py-2.5 hidden sm:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {row.categories.slice(0, 3).map(cat => (
                      <span key={cat} className="text-[10px] px-1.5 py-0.5 rounded border bg-white/5 text-gray-500 border-white/10 whitespace-nowrap">
                        {abbreviateCategory(cat)}
                      </span>
                    ))}
                    {row.categories.length > 3 && (
                      <span className="text-[10px] text-gray-600">+{row.categories.length - 3}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {remaining > 0 && (
        <button
          onClick={() => setShowCount(prev => prev + 50)}
          className="w-full mt-4 py-3 text-sm font-medium text-brand hover:text-brand-hover border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
        >
          Show {Math.min(remaining, 50)} more ({remaining} remaining)
        </button>
      )}

      {/* Source note */}
      <p className="text-xs text-gray-600 mt-6">
        Data sourced from IBDB. Covers {coverage}. Includes acting and creative categories tracked by the Tony Awards.
      </p>
    </div>
  );
}
