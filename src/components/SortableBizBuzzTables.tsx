'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type SortDirection = 'asc' | 'desc';

interface CommercialData {
  designation: string;
  capitalization: number | null;
  recouped: boolean | null;
  recoupedWeeks: number | null;
  recoupedDate: string | null;
}

interface ShowCommercialData {
  show: {
    slug: string;
    title: string;
    status: string;
  };
  commercial: CommercialData | null | undefined;
}

const designationConfig: Record<string, { emoji: string; color: string }> = {
  'Miracle': { emoji: '🌟', color: 'text-yellow-400' },
  'Windfall': { emoji: '💰', color: 'text-emerald-400' },
  'Trickle': { emoji: '💧', color: 'text-blue-400' },
  'Easy Winner': { emoji: '✓', color: 'text-teal-400' },
  'Fizzle': { emoji: '📉', color: 'text-orange-400' },
  'Flop': { emoji: '💥', color: 'text-red-400' },
  'Nonprofit': { emoji: '🎭', color: 'text-purple-400' },
  'TBD': { emoji: '⏳', color: 'text-gray-400' },
};

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  return `$${(amount / 1000).toFixed(0)}K`;
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

// Fastest to Recoup Table
type RecoupColumn = 'show' | 'weeks' | 'capitalization' | 'designation';

interface RecoupTableProps {
  data: ShowCommercialData[];
}

export function RecoupTable({ data }: RecoupTableProps) {
  const [sortColumn, setSortColumn] = useState<RecoupColumn>('weeks');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (column: RecoupColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'show' ? 'asc' : 'asc');
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
        case 'weeks':
          aVal = a.commercial?.recoupedWeeks ?? null;
          bVal = b.commercial?.recoupedWeeks ?? null;
          break;
        case 'capitalization':
          aVal = a.commercial?.capitalization ?? null;
          bVal = b.commercial?.capitalization ?? null;
          break;
        case 'designation':
          aVal = a.commercial?.designation ?? '';
          bVal = b.commercial?.designation ?? '';
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
              <th className={`text-right ${headerClass}`} onClick={() => handleSort('weeks')}>
                Weeks
                <SortIcon direction={sortDirection} active={sortColumn === 'weeks'} />
              </th>
              <th className={`text-right hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('capitalization')}>
                Capitalization
                <SortIcon direction={sortDirection} active={sortColumn === 'capitalization'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('designation')}>
                Designation
                <SortIcon direction={sortDirection} active={sortColumn === 'designation'} />
              </th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Recouped</th>
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
                <td className="py-3 px-4 text-right">
                  <span className="text-white font-bold">{item.commercial?.recoupedWeeks}</span>
                  <span className="text-gray-500 ml-1">wks</span>
                </td>
                <td className="py-3 px-4 text-right text-gray-300 hidden sm:table-cell">
                  {formatCurrency(item.commercial?.capitalization)}
                </td>
                <td className="py-3 px-4 text-center hidden md:table-cell">
                  {item.commercial?.designation && designationConfig[item.commercial.designation] && (
                    <span className={designationConfig[item.commercial.designation].color}>
                      {designationConfig[item.commercial.designation].emoji} {item.commercial.designation}
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-gray-400 text-xs hidden lg:table-cell">
                  {item.commercial?.recoupedDate}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Capitalization Table
type CapColumn = 'show' | 'capitalization' | 'recouped' | 'designation' | 'status';

interface CapitalizationTableProps {
  data: ShowCommercialData[];
}

export function CapitalizationTable({ data }: CapitalizationTableProps) {
  const [sortColumn, setSortColumn] = useState<CapColumn>('capitalization');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (column: CapColumn) => {
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
        case 'capitalization':
          aVal = a.commercial?.capitalization ?? null;
          bVal = b.commercial?.capitalization ?? null;
          break;
        case 'recouped':
          aVal = a.commercial?.recouped === true ? 1 : a.commercial?.recouped === false ? 0 : -1;
          bVal = b.commercial?.recouped === true ? 1 : b.commercial?.recouped === false ? 0 : -1;
          break;
        case 'designation':
          aVal = a.commercial?.designation ?? '';
          bVal = b.commercial?.designation ?? '';
          break;
        case 'status':
          aVal = a.show.status === 'open' ? 0 : 1;
          bVal = b.show.status === 'open' ? 0 : 1;
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
              <th className={`text-right ${headerClass}`} onClick={() => handleSort('capitalization')}>
                Capitalization
                <SortIcon direction={sortDirection} active={sortColumn === 'capitalization'} />
              </th>
              <th className={`text-center hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('recouped')}>
                Recouped?
                <SortIcon direction={sortDirection} active={sortColumn === 'recouped'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('designation')}>
                Designation
                <SortIcon direction={sortDirection} active={sortColumn === 'designation'} />
              </th>
              <th className={`text-center hidden lg:table-cell ${headerClass}`} onClick={() => handleSort('status')}>
                Status
                <SortIcon direction={sortDirection} active={sortColumn === 'status'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => (
              <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="py-3 px-4">
                  <span className="text-gray-500 text-xs font-bold">
                    {index + 1}
                  </span>
                </td>
                <td className="py-3 px-4">
                  <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                    {item.show.title}
                  </Link>
                </td>
                <td className="py-3 px-4 text-right text-white font-bold">
                  {formatCurrency(item.commercial?.capitalization)}
                </td>
                <td className="py-3 px-4 text-center hidden sm:table-cell">
                  {item.commercial?.recouped === true && (
                    <span className="text-emerald-400">✓ Yes</span>
                  )}
                  {item.commercial?.recouped === false && (
                    <span className="text-red-400">✗ No</span>
                  )}
                  {item.commercial?.recouped === null && (
                    <span className="text-gray-500">—</span>
                  )}
                </td>
                <td className="py-3 px-4 text-center hidden md:table-cell">
                  {item.commercial?.designation && designationConfig[item.commercial.designation] && (
                    <span className={designationConfig[item.commercial.designation].color}>
                      {designationConfig[item.commercial.designation].emoji} {item.commercial.designation}
                    </span>
                  )}
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
