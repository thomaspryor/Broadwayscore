'use client';

/**
 * AllShowsTable - Full sortable table of all open shows with commercial data
 * Sprint 2, Task 2.6
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  getDesignationColor,
  getDesignationSortOrder,
  getTrendColor,
  getTrendIcon,
} from '@/config/commercial';
import type { CommercialDesignation, RecoupmentTrend } from '@/lib/data';

interface ShowData {
  slug: string;
  title: string;
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross?: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}

interface AllShowsTableProps {
  shows: ShowData[];
  initialLimit?: number;
}

type SortColumn = 'title' | 'designation' | 'capitalization' | 'gross' | 'totalGross' | 'recoupment';
type SortDirection = 'asc' | 'desc';

function formatCurrency(amount: number | null): string {
  if (amount === null) return '—';
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount}`;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
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

export default function AllShowsTable({ shows, initialLimit = 10 }: AllShowsTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('designation');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expanded, setExpanded] = useState(false);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'title' ? 'asc' : 'desc');
    }
  };

  const sortedShows = useMemo(() => {
    return [...shows].sort((a, b) => {
      let comparison = 0;
      switch (sortColumn) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'designation':
          comparison = getDesignationSortOrder(a.designation) - getDesignationSortOrder(b.designation);
          break;
        case 'capitalization':
          comparison = (a.capitalization || 0) - (b.capitalization || 0);
          break;
        case 'gross':
          comparison = (a.weeklyGross || 0) - (b.weeklyGross || 0);
          break;
        case 'totalGross':
          comparison = (a.totalGross || 0) - (b.totalGross || 0);
          break;
        case 'recoupment':
          const aVal = a.recouped ? 100 : (a.estimatedRecoupmentPct?.[1] || 0);
          const bVal = b.recouped ? 100 : (b.estimatedRecoupmentPct?.[1] || 0);
          comparison = aVal - bVal;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [shows, sortColumn, sortDirection]);

  const displayShows = expanded ? sortedShows : sortedShows.slice(0, initialLimit);

  if (shows.length === 0) {
    return (
      <div className="card rounded-xl p-6 text-center">
        <p className="text-gray-500">No commercial data available</p>
      </div>
    );
  }

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay">
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('title')}
                aria-sort={sortColumn === 'title' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Show
                <SortIcon active={sortColumn === 'title'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('designation')}
                aria-sort={sortColumn === 'designation' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Designation
                <SortIcon active={sortColumn === 'designation'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('capitalization')}
                aria-sort={sortColumn === 'capitalization' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Capitalization
                <SortIcon active={sortColumn === 'capitalization'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group hidden md:table-cell"
                onClick={() => handleSort('gross')}
                aria-sort={sortColumn === 'gross' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Weekly Gross
                <SortIcon active={sortColumn === 'gross'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group hidden lg:table-cell"
                onClick={() => handleSort('totalGross')}
                aria-sort={sortColumn === 'totalGross' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Total Gross
                <SortIcon active={sortColumn === 'totalGross'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group hidden xl:table-cell"
                onClick={() => handleSort('recoupment')}
                aria-sort={sortColumn === 'recoupment' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Est. Recouped
                <SortIcon active={sortColumn === 'recoupment'} direction={sortDirection} />
              </th>
              <th className="py-3 px-4 font-medium hidden sm:table-cell" title="Weeks to recoup (for recouped shows) or trend (for in-progress shows)">Time to Recoup</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {displayShows.map((show) => {
              const designationColorClass = getDesignationColor(show.designation);
              return (
                <tr
                  key={show.slug}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="py-3 px-4">
                    <Link
                      href={`/show/${show.slug}`}
                      className="font-medium text-white hover:text-brand transition-colors"
                    >
                      {show.title}
                    </Link>
                  </td>
                  <td className="py-3 px-4">
                    <span className={designationColorClass}>{show.designation}</span>
                  </td>
                  <td className="py-3 px-4">
                    {show.capitalization ? `~${formatCurrency(show.capitalization)}` : '—'}
                  </td>
                  <td className="py-3 px-4 hidden md:table-cell">
                    {formatCurrency(show.weeklyGross)}
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    {formatCurrency(show.totalGross || null)}
                  </td>
                  <td className="py-3 px-4 hidden xl:table-cell">
                    {show.recouped ? (
                      <span className="text-emerald-400">Recouped</span>
                    ) : show.estimatedRecoupmentPct ? (
                      <span className="text-amber-400">
                        ~{show.estimatedRecoupmentPct[0]}-{show.estimatedRecoupmentPct[1]}%
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <span
                      className={getTrendColor(show.trend, show.recouped)}
                      aria-label={show.recouped ? 'Recouped' : show.trend}
                    >
                      {show.recouped
                        ? show.recoupedWeeks
                          ? `~${show.recoupedWeeks} wks`
                          : '—'
                        : getTrendIcon(show.trend, show.recouped)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shows.length > initialLimit && (
        <div className="p-4 border-t border-white/5 text-center">
          <span className="text-gray-500 text-sm">
            Showing {displayShows.length} of {shows.length} open shows ·{' '}
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-brand hover:text-brand-hover text-sm transition-colors"
          >
            {expanded ? 'Show less' : 'View all →'}
          </button>
        </div>
      )}
    </div>
  );
}
