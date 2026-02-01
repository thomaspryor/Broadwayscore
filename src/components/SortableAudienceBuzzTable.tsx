'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type SortDirection = 'asc' | 'desc';

interface AudienceBuzzSource {
  score: number;
  reviewCount: number;
  starRating?: number;
}

interface AudienceBuzzData {
  title: string;
  designation: string;
  combinedScore: number;
  sources: {
    showScore: AudienceBuzzSource | null;
    mezzanine: AudienceBuzzSource | null;
    reddit: AudienceBuzzSource | null;
  };
}

interface ShowBuzzData {
  show: {
    slug: string;
    title: string;
    status: string;
  };
  buzz: AudienceBuzzData | null | undefined;
}

const designationConfig: Record<string, { emoji: string; color: string; displayLabel: string }> = {
  'Loving': { emoji: '❤️', color: 'text-red-400', displayLabel: 'Loving It' },
  'Liking': { emoji: '👍', color: 'text-emerald-400', displayLabel: 'Liking It' },
  'Shrugging': { emoji: '🤷', color: 'text-yellow-400', displayLabel: 'Shrugging' },
  'Loathing': { emoji: '💩', color: 'text-gray-400', displayLabel: 'Loathing It' },
};

function SortIcon({ direction, active }: { direction: SortDirection | null; active: boolean }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">
        ↕
      </span>
    );
  }
  return (
    <span className="ml-1 text-brand">
      {direction === 'asc' ? '↑' : '↓'}
    </span>
  );
}

type BuzzColumn = 'show' | 'score' | 'showScore' | 'mezzanine' | 'reddit' | 'designation';

interface AudienceBuzzTableProps {
  data: ShowBuzzData[];
}

export function AudienceBuzzTable({ data }: AudienceBuzzTableProps) {
  const [sortColumn, setSortColumn] = useState<BuzzColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: BuzzColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'show' ? 'asc' : 'desc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.show.title.toLowerCase();
          bVal = b.show.title.toLowerCase();
          break;
        case 'score':
          aVal = a.buzz?.combinedScore ?? null;
          bVal = b.buzz?.combinedScore ?? null;
          break;
        case 'showScore':
          aVal = a.buzz?.sources.showScore?.score ?? null;
          bVal = b.buzz?.sources.showScore?.score ?? null;
          break;
        case 'mezzanine':
          aVal = a.buzz?.sources.mezzanine?.score ?? null;
          bVal = b.buzz?.sources.mezzanine?.score ?? null;
          break;
        case 'reddit':
          aVal = a.buzz?.sources.reddit?.score ?? null;
          bVal = b.buzz?.sources.reddit?.score ?? null;
          break;
        case 'designation':
          const order = ['Loving', 'Liking', 'Shrugging', 'Loathing'];
          aVal = order.indexOf(a.buzz?.designation || '') ?? 99;
          bVal = order.indexOf(b.buzz?.designation || '') ?? 99;
          break;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = "py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
              <th className={`text-center hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('showScore')}>
                Show Score
                <SortIcon direction={sortDirection} active={sortColumn === 'showScore'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('mezzanine')}>
                Mezzanine
                <SortIcon direction={sortDirection} active={sortColumn === 'mezzanine'} />
              </th>
              <th className={`text-center hidden lg:table-cell ${headerClass}`} onClick={() => handleSort('reddit')}>
                Reddit
                <SortIcon direction={sortDirection} active={sortColumn === 'reddit'} />
              </th>
              <th className={`text-center hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('designation')}>
                Designation
                <SortIcon direction={sortDirection} active={sortColumn === 'designation'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const buzz = item.buzz;
              const config = designationConfig[buzz?.designation || ''] || { emoji: '—', color: 'text-gray-500' };

              return (
                <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                      {item.show.title}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <span className={`text-xl font-bold ${
                      (buzz?.combinedScore || 0) >= 88 ? 'text-red-400' :
                      (buzz?.combinedScore || 0) >= 78 ? 'text-emerald-400' :
                      (buzz?.combinedScore || 0) >= 68 ? 'text-yellow-400' :
                      'text-gray-400'
                    }`}>
                      {buzz?.combinedScore || '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-center hidden sm:table-cell">
                    {buzz?.sources.showScore ? (
                      <div>
                        <span className="text-white font-medium">{buzz.sources.showScore.score}</span>
                        <span className="text-gray-500 text-xs ml-1">({buzz.sources.showScore.reviewCount.toLocaleString()})</span>
                      </div>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell">
                    {buzz?.sources.mezzanine ? (
                      <div>
                        <span className="text-white font-medium">{buzz.sources.mezzanine.score}</span>
                        <span className="text-gray-500 text-xs ml-1">({buzz.sources.mezzanine.reviewCount.toLocaleString()})</span>
                      </div>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center hidden lg:table-cell">
                    {buzz?.sources.reddit ? (
                      <div>
                        <span className="text-white font-medium">{buzz.sources.reddit.score}</span>
                        <span className="text-gray-500 text-xs ml-1">({buzz.sources.reddit.reviewCount})</span>
                      </div>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center hidden sm:table-cell">
                    <span className={config.color}>
                      {config.emoji} {config.displayLabel || buzz?.designation || '—'}
                    </span>
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
