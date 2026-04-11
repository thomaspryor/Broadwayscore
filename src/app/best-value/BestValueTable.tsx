'use client';

import { Fragment, useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';
import { formatTicketPrice } from '@/lib/formatting';

type SortDirection = 'asc' | 'desc';
type SortColumn = 'show' | 'bestPrice' | 'options' | 'score';
type TicketMarket = 'broadway' | 'west-end';

export interface BestValueRow {
  slug: string;
  title: string;
  score: number | null;
  bestPrice: number;
  bestType: string;
  bestColor: string;
  bestBgColor: string;
  optionCount: number;
  allOptions: { price: number; label: string; color: string; bgColor: string }[];
}

function SortIcon({ direction, active }: { direction: SortDirection; active: boolean }) {
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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

interface BestValueTableProps {
  rows: BestValueRow[];
  market?: TicketMarket;
}

export function BestValueTable({ rows, market = 'broadway' }: BestValueTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('bestPrice');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'score' ? 'desc' : 'asc');
    }
  };

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      let aVal: number | string | null = null;
      let bVal: number | string | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'bestPrice':
          aVal = a.bestPrice;
          bVal = b.bestPrice;
          break;
        case 'options':
          aVal = a.optionCount;
          bVal = b.optionCount;
          break;
        case 'score':
          aVal = a.score;
          bVal = b.score;
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
  }, [rows, sortColumn, sortDirection]);

  const headerClass = "py-3 px-2 sm:px-3 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group text-sm";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-2 sm:px-3 text-gray-400 font-medium text-sm w-6 sm:w-8 hidden sm:table-cell">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-center whitespace-nowrap ${headerClass}`} onClick={() => handleSort('bestPrice')}>
                <span className="hidden sm:inline">Best Price</span>
                <span className="sm:hidden">Price</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'bestPrice'} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('options')}>
                <span className="hidden sm:inline">Options</span>
                <span className="sm:hidden">Opts</span>
                <SortIcon direction={sortDirection} active={sortColumn === 'options'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const isExpanded = expandedSlug === row.slug;
              const hasMultiple = row.optionCount > 1;

              return (
                <Fragment key={row.slug}>
                  <tr
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasMultiple ? 'cursor-pointer' : ''} ${isExpanded ? 'border-b-0' : ''}`}
                    onClick={() => hasMultiple && setExpandedSlug(isExpanded ? null : row.slug)}
                  >
                    <td className="py-3 px-2 sm:px-3 w-6 sm:w-8 hidden sm:table-cell">
                      <span className="text-gray-500 text-xs font-bold">
                        {index + 1}
                      </span>
                    </td>
                    <td className="py-3 px-2 sm:px-3">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Link
                          href={`/show/${row.slug}`}
                          className="text-white hover:text-brand transition-colors font-medium text-sm sm:text-base truncate"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.title}
                        </Link>
                        {hasMultiple && (
                          <span className="shrink-0">
                            <ChevronIcon open={isExpanded} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-center whitespace-nowrap">
                      <span className={`inline-flex items-center px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md sm:rounded-lg border text-xs sm:text-sm font-semibold ${row.bestBgColor} ${row.bestColor}`}>
                        {formatTicketPrice(row.bestPrice, market)}
                      </span>
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-center text-gray-300">
                      {row.optionCount}
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-center hidden md:table-cell">
                      <ScoreBadge score={row.score} size="sm" showCrown />
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-white/[0.02] border-b border-white/5">
                      <td colSpan={4} className="px-4 py-2">
                        <div className="flex flex-wrap gap-2">
                          {row.allOptions.map((opt, i) => (
                            <span
                              key={i}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-sm font-medium ${opt.bgColor} ${opt.color} ${i === 0 ? 'ring-1 ring-white/20' : ''}`}
                            >
                              {formatTicketPrice(opt.price, market)} {opt.label}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
