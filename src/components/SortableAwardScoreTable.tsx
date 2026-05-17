'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { AwardScoreBadge, AWARD_TIER_LABEL } from '@/components/show-cards/AwardScoreBadge';
import type { ScoreResult } from '@/lib/awards-scoring';

type SortDirection = 'asc' | 'desc';
type SortColumn = 'show' | 'score';

interface ShowAwardData {
  show: {
    slug: string;
    title: string;
  };
  awardScore: ScoreResult;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">↕</span>;
  }
  return <span className="ml-1 text-brand">{direction === 'asc' ? '↑' : '↓'}</span>;
}

interface SortableAwardScoreTableProps {
  data: ShowAwardData[];
}

export function SortableAwardScoreTable({ data }: SortableAwardScoreTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection(col === 'show' ? 'asc' : 'desc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      if (sortColumn === 'show') {
        const cmp = a.show.title.toLowerCase().localeCompare(b.show.title.toLowerCase());
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      const diff = (a.awardScore.displayScore ?? 0) - (b.awardScore.displayScore ?? 0);
      return sortDirection === 'asc' ? diff : -diff;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = 'py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group';

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon active={sortColumn === 'show'} direction={sortDirection} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('score')}>
                Award Score
                <SortIcon active={sortColumn === 'score'} direction={sortDirection} />
              </th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Tier</th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden md:table-cell">Tony W/N</th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const { awardScore, show } = item;
              const tonyRecord = awardScore.tonyWins > 0 || awardScore.tonyNoms > 0
                ? `${awardScore.tonyWins}W ${awardScore.tonyNoms}N`
                : '—';

              return (
                <tr key={show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Link href={`/show/${show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                        {show.title}
                      </Link>
                      {awardScore.inProgress && (
                        <span className="text-xs text-amber-400 font-medium">★ In Progress</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <AwardScoreBadge
                      score={awardScore.displayScore}
                      badge={awardScore.badge}
                      inProgress={awardScore.inProgress}
                      size="md"
                    />
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <span className="text-gray-400 text-sm">{AWARD_TIER_LABEL[awardScore.badge]}</span>
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell">
                    <span className="text-gray-400 text-sm">{tonyRecord}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
