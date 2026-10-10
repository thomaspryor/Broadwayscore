'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';

type SortDirection = 'asc' | 'desc';

interface ShowGrossesData {
  show: {
    slug: string;
    title: string;
    status: string;
    images?: {
      hero?: string;
      thumbnail?: string;
      poster?: string;
    };
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

// Fixed-width slot keeps values right-aligned across rows whether or not a delta renders.
const DELTA_SLOT = 'inline-block w-14 text-left text-xs ml-1 tabular-nums';

function ChangeIndicator({ current, previous, mode = 'percent' }: { current: number | null | undefined; previous: number | null | undefined; mode?: 'percent' | 'points' }) {
  // No prior-week data — leave the slot empty so values still column-align.
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return <span className={DELTA_SLOT} aria-hidden="true" />;
  }
  // 'percent' = percentage change ((new-old)/old*100), used for gross/attendance
  // 'points' = percentage point change (new-old), used for capacity which is already a %
  const change = mode === 'points' ? (current - previous) : ((current - previous) / previous) * 100;
  const unit = mode === 'points' ? 'pp' : '%';

  // Effectively unchanged — render in neutral gray so the user can tell
  // "we have data and it didn't move" apart from "no prior data" (empty slot).
  if (Math.abs(change) < 0.1) {
    return (
      <span className={`${DELTA_SLOT} text-gray-500`} title="Unchanged from last week">
        0.0{unit}
      </span>
    );
  }

  const isPositive = change > 0;
  return (
    <span className={`${DELTA_SLOT} ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? '↑' : '↓'}{Math.abs(change).toFixed(1)}{unit}
    </span>
  );
}

function ShowThumbnail({ show }: { show: ShowGrossesData['show'] }) {
  return (
    <div className="relative flex-shrink-0 w-10 h-14 rounded overflow-hidden bg-surface-overlay">
      <ShowImage
        sources={[
          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'card') : null,
          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'card') : null,
          show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'card') : null,
        ]}
        alt=""
        loading="lazy"
        ariaHidden
        className="w-full h-full object-cover"
        fallback={
          <div className="w-full h-full flex items-center justify-center text-gray-500" aria-hidden="true">
            <span className="text-base">🎭</span>
          </div>
        }
      />
    </div>
  );
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

  const headerClass = "py-3 px-2 sm:px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group text-sm";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 pl-3 pr-1 sm:px-4 text-gray-400 font-medium text-sm w-6 sm:w-8">#</th>
              <th
                className={`text-left ${headerClass}`}
                onClick={() => handleSort('show')}
              >
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th
                className={`text-right ${headerClass} whitespace-nowrap`}
                onClick={() => handleSort('gross')}
              >
                Gross
                <SortIcon direction={sortDirection} active={sortColumn === 'gross'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('capacity')}
              >
                <span className="hidden sm:inline">Capacity</span>
                <span className="sm:hidden">Cap</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'capacity'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('atp')}
              >
                <span className="hidden lg:inline">Avg Ticket</span>
                <span className="lg:hidden">ATP</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'atp'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('attendance')}
              >
                <span className="hidden sm:inline">Attendance</span>
                <span className="sm:hidden">Attend</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'attendance'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => (
              <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="py-3 pl-3 pr-1 sm:px-4 w-6 sm:w-8 align-middle">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                    index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                  }`}>
                    {index + 1}
                  </span>
                </td>
                <td className="py-3 px-2 sm:px-4 min-w-0 align-middle">
                  <Link href={`/show/${item.show.slug}`} className="flex items-center gap-3 group">
                    <ShowThumbnail show={item.show} />
                    <span className="text-white group-hover:text-brand transition-colors font-medium text-sm sm:text-base leading-tight line-clamp-2">
                      {item.show.title}
                    </span>
                  </Link>
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-white font-medium whitespace-nowrap align-middle">
                  {formatCurrency(item.grosses?.thisWeek?.gross)}
                  <ChangeIndicator
                    current={item.grosses?.thisWeek?.gross}
                    previous={item.grosses?.thisWeek?.grossPrevWeek}
                  />
                </td>
                <td
                  className="py-3 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap align-middle"
                  title={
                    (item.grosses?.thisWeek?.capacity ?? 0) > 100
                      ? 'Capacity above 100% reflects extra performances or premium pricing reported by The Broadway League.'
                      : undefined
                  }
                >
                  {formatPercent(item.grosses?.thisWeek?.capacity)}
                  {(item.grosses?.thisWeek?.capacity ?? 0) > 100 && (
                    <span className="text-gray-500 ml-0.5" aria-hidden="true">*</span>
                  )}
                  <ChangeIndicator
                    current={item.grosses?.thisWeek?.capacity}
                    previous={item.grosses?.thisWeek?.capacityPrevWeek}
                    mode="points"
                  />
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap align-middle">
                  {item.grosses?.thisWeek?.atp ? `$${item.grosses.thisWeek.atp.toFixed(0)}` : '—'}
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap align-middle">
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

  const headerClass = "py-3 px-2 sm:px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group text-sm";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 pl-3 pr-1 sm:px-4 text-gray-400 font-medium text-sm w-6 sm:w-8">#</th>
              <th
                className={`text-left ${headerClass}`}
                onClick={() => handleSort('show')}
              >
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('gross')}
              >
                <span className="hidden sm:inline">Total Gross</span>
                <span className="sm:hidden">Gross</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'gross'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('performances')}
              >
                <span className="hidden sm:inline">Performances</span>
                <span className="sm:hidden">Perfs</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'performances'} />
              </th>
              <th
                className={`text-right whitespace-nowrap ${headerClass}`}
                onClick={() => handleSort('attendance')}
              >
                <span className="hidden sm:inline">Attendance</span>
                <span className="sm:hidden">Attend</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'attendance'} />
              </th>
              <th
                className={`text-center whitespace-nowrap ${headerClass}`}
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
                <td className="py-3 pl-3 pr-1 sm:px-4 w-6 sm:w-8 align-middle">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                    index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                  }`}>
                    {index + 1}
                  </span>
                </td>
                <td className="py-3 px-2 sm:px-4 min-w-0 align-middle">
                  <Link href={`/show/${item.show.slug}`} className="flex items-center gap-3 group">
                    <ShowThumbnail show={item.show} />
                    <span className="text-white group-hover:text-brand transition-colors font-medium text-sm sm:text-base leading-tight line-clamp-2">
                      {item.show.title}
                    </span>
                  </Link>
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-white font-medium whitespace-nowrap align-middle">
                  {formatCurrency(item.grosses?.allTime?.gross)}
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap align-middle">
                  {formatNumber(item.grosses?.allTime?.performances)}
                </td>
                <td className="py-3 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap align-middle">
                  {formatNumber(item.grosses?.allTime?.attendance)}
                </td>
                <td className="py-3 px-2 sm:px-4 text-center whitespace-nowrap align-middle">
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
