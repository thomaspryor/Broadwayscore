'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type SortDirection = 'asc' | 'desc';

interface ShowGrossesData {
  show: {
    slug: string;
    title: string;
    status: string;
  };
  grosses: {
    thisWeek?: {
      gross: number | null;
      grossPrevWeek: number | null;
      capacity: number | null;
      capacityPrevWeek: number | null;
      atp: number | null;
      attendance: number | null;
    };
    allTime?: {
      gross: number | null;
      performances: number | null;
      attendance: number | null;
    };
  } | null | undefined;
}

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  if (amount >= 1000000000) {
    return `$${(amount / 1000000000).toFixed(1)}B`;
  }
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(0)}K`;
  }
  return `$${amount.toLocaleString()}`;
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '—';
  return num.toLocaleString();
}

function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '—';
  return `${pct.toFixed(1)}%`;
}

function ChangeIndicator({ current, previous }: { current: number | null | undefined; previous: number | null | undefined }) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.1) return null;

  const isPositive = change > 0;
  return (
    <span className={`text-xs ml-1 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? '↑' : '↓'}{Math.abs(change).toFixed(1)}%
    </span>
  );
}

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

// This Week's Table
type ThisWeekColumn = 'show' | 'gross' | 'capacity' | 'atp' | 'attendance';

interface ThisWeekTableProps {
  data: ShowGrossesData[];
}

export function ThisWeekTable({ data }: ThisWeekTableProps) {
  const [sortColumn, setSortColumn] = useState<ThisWeekColumn>('gross');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: ThisWeekColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
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
        case 'gross':
          aVal = a.grosses?.thisWeek?.gross ?? null;
          bVal = b.grosses?.thisWeek?.gross ?? null;
          break;
        case 'capacity':
          aVal = a.grosses?.thisWeek?.capacity ?? null;
          bVal = b.grosses?.thisWeek?.capacity ?? null;
          break;
        case 'atp':
          aVal = a.grosses?.thisWeek?.atp ?? null;
          bVal = b.grosses?.thisWeek?.atp ?? null;
          break;
        case 'attendance':
          aVal = a.grosses?.thisWeek?.attendance ?? null;
          bVal = b.grosses?.thisWeek?.attendance ?? null;
          break;
      }

      // Handle nulls - push to end
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      // Compare
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
              <th
                className={`text-left ${headerClass}`}
                onClick={() => handleSort('show')}
              >
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th
                className={`text-right ${headerClass}`}
                onClick={() => handleSort('gross')}
              >
                Gross
                <SortIcon direction={sortDirection} active={sortColumn === 'gross'} />
              </th>
              <th
                className={`text-right hidden sm:table-cell ${headerClass}`}
                onClick={() => handleSort('capacity')}
              >
                Capacity
                <SortIcon direction={sortDirection} active={sortColumn === 'capacity'} />
              </th>
              <th
                className={`text-right hidden md:table-cell ${headerClass}`}
                onClick={() => handleSort('atp')}
              >
                Avg Ticket
                <SortIcon direction={sortDirection} active={sortColumn === 'atp'} />
              </th>
              <th
                className={`text-right hidden lg:table-cell ${headerClass}`}
                onClick={() => handleSort('attendance')}
              >
                Attendance
                <SortIcon direction={sortDirection} active={sortColumn === 'attendance'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => (
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
                <td className="py-3 px-4 text-right text-white font-medium">
                  {formatCurrency(item.grosses?.thisWeek?.gross)}
                  <ChangeIndicator
                    current={item.grosses?.thisWeek?.gross}
                    previous={item.grosses?.thisWeek?.grossPrevWeek}
                  />
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden sm:table-cell">
                  {formatPercent(item.grosses?.thisWeek?.capacity)}
                  <ChangeIndicator
                    current={item.grosses?.thisWeek?.capacity}
                    previous={item.grosses?.thisWeek?.capacityPrevWeek}
                  />
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden md:table-cell">
                  {item.grosses?.thisWeek?.atp ? `$${item.grosses.thisWeek.atp.toFixed(0)}` : '—'}
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden lg:table-cell">
                  {formatNumber(item.grosses?.thisWeek?.attendance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// All-Time Table
type AllTimeColumn = 'show' | 'gross' | 'performances' | 'attendance' | 'status';

interface AllTimeTableProps {
  data: ShowGrossesData[];
}

export function AllTimeTable({ data }: AllTimeTableProps) {
  const [sortColumn, setSortColumn] = useState<AllTimeColumn>('gross');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: AllTimeColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
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
        case 'gross':
          aVal = a.grosses?.allTime?.gross ?? null;
          bVal = b.grosses?.allTime?.gross ?? null;
          break;
        case 'performances':
          aVal = a.grosses?.allTime?.performances ?? null;
          bVal = b.grosses?.allTime?.performances ?? null;
          break;
        case 'attendance':
          aVal = a.grosses?.allTime?.attendance ?? null;
          bVal = b.grosses?.allTime?.attendance ?? null;
          break;
        case 'status':
          // Sort open shows first when ascending, closed first when descending
          aVal = a.show.status === 'open' ? 0 : 1;
          bVal = b.show.status === 'open' ? 0 : 1;
          break;
      }

      // Handle nulls - push to end
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      // Compare
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
              <th
                className={`text-left ${headerClass}`}
                onClick={() => handleSort('show')}
              >
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th
                className={`text-right ${headerClass}`}
                onClick={() => handleSort('gross')}
              >
                Total Gross
                <SortIcon direction={sortDirection} active={sortColumn === 'gross'} />
              </th>
              <th
                className={`text-right hidden sm:table-cell ${headerClass}`}
                onClick={() => handleSort('performances')}
              >
                Performances
                <SortIcon direction={sortDirection} active={sortColumn === 'performances'} />
              </th>
              <th
                className={`text-right hidden md:table-cell ${headerClass}`}
                onClick={() => handleSort('attendance')}
              >
                Attendance
                <SortIcon direction={sortDirection} active={sortColumn === 'attendance'} />
              </th>
              <th
                className={`text-center hidden lg:table-cell ${headerClass}`}
                onClick={() => handleSort('status')}
              >
                Status
                <SortIcon direction={sortDirection} active={sortColumn === 'status'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => (
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
                <td className="py-3 px-4 text-right text-white font-medium">
                  {formatCurrency(item.grosses?.allTime?.gross)}
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden sm:table-cell">
                  {formatNumber(item.grosses?.allTime?.performances)}
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden md:table-cell">
                  {formatNumber(item.grosses?.allTime?.attendance)}
                </td>
                <td className="py-3 px-4 text-center hidden lg:table-cell">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    item.show.status === 'open'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-gray-500/15 text-gray-400'
                  }`}>
                    {item.show.status === 'open' ? 'Running' : 'Closed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
