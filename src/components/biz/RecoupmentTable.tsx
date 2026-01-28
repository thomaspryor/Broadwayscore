'use client';

/**
 * RecoupmentTable - Sortable table for recent recoupments
 * Sprint 2, Task 2.5
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';

interface RecoupmentShow {
  slug: string;
  title: string;
  season: string;
  weeksToRecoup: number;
  capitalization: number;
  recoupDate: string;
}

interface RecoupmentTableProps {
  shows: RecoupmentShow[];
}

type SortColumn = 'title' | 'weeks' | 'capitalization' | 'date';
type SortDirection = 'asc' | 'desc';

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount}`;
}

function formatDate(dateStr: string): string {
  // Input: "2025-01" or "2024-06"
  const [year, month] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month) - 1]} ${year}`;
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

export default function RecoupmentTable({ shows }: RecoupmentTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

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
        case 'weeks':
          comparison = a.weeksToRecoup - b.weeksToRecoup;
          break;
        case 'capitalization':
          comparison = a.capitalization - b.capitalization;
          break;
        case 'date':
          comparison = new Date(a.recoupDate).getTime() - new Date(b.recoupDate).getTime();
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [shows, sortColumn, sortDirection]);

  if (shows.length === 0) {
    return (
      <div className="card rounded-xl p-6 text-center">
        <p className="text-gray-500">No recent recoupments</p>
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
              <th className="py-3 px-4 font-medium hidden sm:table-cell">Season</th>
              <th
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('weeks')}
                aria-sort={sortColumn === 'weeks' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Weeks
                <SortIcon active={sortColumn === 'weeks'} direction={sortDirection} />
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
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group hidden sm:table-cell"
                onClick={() => handleSort('date')}
                aria-sort={sortColumn === 'date' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Recoup Date
                <SortIcon active={sortColumn === 'date'} direction={sortDirection} />
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {sortedShows.map((show) => (
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
                <td className="py-3 px-4 text-gray-400 hidden sm:table-cell">
                  {show.season}
                </td>
                <td className="py-3 px-4 text-emerald-400 font-semibold">
                  ~{show.weeksToRecoup}
                </td>
                <td className="py-3 px-4">~{formatCurrency(show.capitalization)}</td>
                <td className="py-3 px-4 text-gray-500 hidden sm:table-cell">
                  {formatDate(show.recoupDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
