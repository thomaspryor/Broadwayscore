'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { type AudienceSourceConfig } from '@/config/audience-sources';

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
  sources: Record<string, AudienceBuzzSource | null>;
}

interface ShowBuzzData {
  show: {
    slug: string;
    title: string;
    status: string;
  };
  buzz: AudienceBuzzData | null | undefined;
}

function getGradeFromScore(score: number): { grade: string; color: string } {
  if (score >= 90) return { grade: 'A+', color: '#22c55e' };
  if (score >= 88) return { grade: 'A', color: '#16a34a' };
  if (score >= 83) return { grade: 'A-', color: '#14b8a6' };
  if (score >= 78) return { grade: 'B+', color: '#0ea5e9' };
  if (score >= 73) return { grade: 'B', color: '#f59e0b' };
  if (score >= 68) return { grade: 'B-', color: '#f97316' };
  if (score >= 63) return { grade: 'C+', color: '#ef4444' };
  if (score >= 58) return { grade: 'C', color: '#dc2626' };
  if (score >= 53) return { grade: 'C-', color: '#b91c1c' };
  if (score >= 48) return { grade: 'D', color: '#991b1b' };
  return { grade: 'F', color: '#6b7280' };
}

function SortIcon({ direction, active }: { direction: SortDirection | null; active: boolean }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
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

type BuzzColumn = 'show' | 'score' | 'grade' | string;

interface AudienceBuzzTableProps {
  data: ShowBuzzData[];
  sources?: AudienceSourceConfig[];
}

export function AudienceBuzzTable({ data, sources }: AudienceBuzzTableProps) {
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

      if (sortColumn === 'show') {
        aVal = a.show.title.toLowerCase();
        bVal = b.show.title.toLowerCase();
      } else if (sortColumn === 'score' || sortColumn === 'grade') {
        aVal = a.buzz?.combinedScore ?? null;
        bVal = b.buzz?.combinedScore ?? null;
      } else {
        aVal = a.buzz?.sources[sortColumn]?.score ?? null;
        bVal = b.buzz?.sources[sortColumn]?.score ?? null;
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
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('grade')}>
                Grade
                <SortIcon direction={sortDirection} active={sortColumn === 'grade'} />
              </th>
              {sources?.map((src, i) => (
                <th
                  key={src.key}
                  className={`text-center ${i < 1 ? 'hidden sm:table-cell' : i < 2 ? 'hidden md:table-cell' : 'hidden lg:table-cell'} ${headerClass}`}
                  onClick={() => handleSort(src.key)}
                >
                  {src.name}
                  <SortIcon direction={sortDirection} active={sortColumn === src.key} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const buzz = item.buzz;
              const gradeInfo = buzz ? getGradeFromScore(buzz.combinedScore) : null;

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
                    {gradeInfo ? (
                      <span
                        className="inline-flex items-center justify-center px-2.5 py-1 rounded-md text-sm font-bold"
                        style={{ color: gradeInfo.color, backgroundColor: `${gradeInfo.color}20` }}
                      >
                        {gradeInfo.grade}
                      </span>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  {sources?.map((src, i) => {
                    let srcData = buzz?.sources[src.key];
                    // Per-source minimum-volume gates (mirrors audience-weighting.js).
                    if (srcData && src.key === 'theatr' && (srcData.reviewCount || 0) < 10) {
                      srcData = null;
                    }
                    return (
                      <td key={src.key} className={`py-3 px-4 text-center ${i < 1 ? 'hidden sm:table-cell' : i < 2 ? 'hidden md:table-cell' : 'hidden lg:table-cell'}`}>
                        {srcData ? (
                          <span className="text-gray-400 text-sm">{srcData.reviewCount.toLocaleString()} {src.volumeLabel}</span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
