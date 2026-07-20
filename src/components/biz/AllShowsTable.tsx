'use client';

/**
 * AllShowsTable - Full sortable table of all open shows with commercial data
 * Sprint 2, Task 2.6. % Recouped / Return columns added Sprint A (task #158).
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  getDesignationColor,
  getDesignationSortOrder,
  getTrendColor,
  getTrendIcon,
} from '@/config/commercial';
import type { CommercialDesignation, RecoupmentTrend } from '@/lib/data-types';
import { formatCurrency, formatEstimatedCurrency } from '@/lib/biz-format';
import { getRecoupmentDisplayMode, meetsModelQualityFloor } from '@/lib/commercial-display';
import RecoupmentProgressBar from '@/components/RecoupmentProgressBar';

interface ShowData {
  slug: string;
  title: string;
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross?: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  modelRecoupmentPct?: [number, number, number] | null;
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  modelDataQuality?: 'high' | 'medium' | 'low';
  investorMultiple?: number | null;
  recoupedSource?: string | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}

interface AllShowsTableProps {
  shows: ShowData[];
  initialLimit?: number;
}

type SortColumn = 'title' | 'designation' | 'capitalization' | 'gross' | 'totalGross' | 'recoupment' | 'return';
type SortDirection = 'asc' | 'desc';

/** Profit multiple for the Return column — investorMultiple when reported,
 *  else the model's central estimate (only above the quality floor). Blank
 *  for anything not confirmed recouped.
 *
 *  This is the same ratio the shared RecoupmentProgressBar already uses to
 *  render "~Nx returned to investors" once modelRecoupmentPct crosses 200%
 *  (see src/components/RecoupmentProgressBar.tsx) — percent-of-capitalization
 *  recouped and multiple-of-capital-returned are the same number at
 *  different scales, not two different metrics. */
function getProfitMultiple(show: ShowData): number | null {
  if (!show.recouped) return null;
  if (show.investorMultiple != null) return show.investorMultiple;
  if (show.modelRecoupmentPct && meetsModelQualityFloor(show)) {
    return show.modelRecoupmentPct[1] / 100;
  }
  return null;
}

/** Sort key for the % Recouped column — mirrors what RecoupedCell actually
 *  renders (via getRecoupmentDisplayMode/meetsModelQualityFloor) so a row
 *  showing "—" never sorts as if it had a real number. No fallback to the
 *  legacy AI-estimated `estimatedRecoupmentPct` — that value is exactly
 *  what the quality floor excludes from display. */
function getRecoupedSortValue(show: ShowData): number {
  const mode = getRecoupmentDisplayMode(show);
  if (mode === 'announced') return show.modelRecoupmentPct?.[1] ?? 100;
  if (mode === 'model') return show.modelRecoupmentPct![1];
  return -Infinity;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
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

function CitationIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5M10.172 13.828a4 4 0 010-5.656l3-3a4 4 0 015.656 5.656l-1.5 1.5" />
    </svg>
  );
}

/** % Recouped cell: announced/cited recoupment renders solid + a citation
 *  marker; a modeled estimate renders the shared progress bar with a "~"
 *  provenance tooltip; anything below the quality floor renders "—". */
function RecoupedCell({ show }: { show: ShowData }) {
  const displayMode = getRecoupmentDisplayMode(show);

  if (displayMode === 'announced') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold text-sm">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Recouped
        </span>
        {show.recoupedSource && (
          <span
            className="text-gray-500 cursor-help"
            title={`Source: ${show.recoupedSource}`}
            aria-label={`Cited source: ${show.recoupedSource}`}
          >
            <CitationIcon />
          </span>
        )}
      </div>
    );
  }

  if (displayMode === 'model' && show.modelRecoupmentPct) {
    return (
      <div className="w-36 sm:w-40" title="Modeled estimate — see methodology">
        <RecoupmentProgressBar estimatedPct={show.modelRecoupmentPct} modelMethod={show.modelMethod} />
      </div>
    );
  }

  return <span className="text-gray-500">—</span>;
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
          comparison = (a.capitalization ?? -Infinity) - (b.capitalization ?? -Infinity);
          break;
        case 'gross':
          comparison = (a.weeklyGross ?? -Infinity) - (b.weeklyGross ?? -Infinity);
          break;
        case 'totalGross':
          comparison = (a.totalGross ?? -Infinity) - (b.totalGross ?? -Infinity);
          break;
        case 'recoupment': {
          comparison = getRecoupedSortValue(a) - getRecoupedSortValue(b);
          break;
        }
        case 'return': {
          const aVal = getProfitMultiple(a) ?? -Infinity;
          const bVal = getProfitMultiple(b) ?? -Infinity;
          comparison = aVal - bVal;
          break;
        }
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
                onClick={() => handleSort('recoupment')}
                aria-sort={sortColumn === 'recoupment' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                % Recouped
                <SortIcon active={sortColumn === 'recoupment'} direction={sortDirection} />
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
                className="py-3 px-4 font-medium cursor-pointer hover:text-white transition-colors select-none group hidden sm:table-cell"
                onClick={() => handleSort('return')}
                aria-sort={sortColumn === 'return' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                title="Profit multiple for recouped shows"
              >
                Return
                <SortIcon active={sortColumn === 'return'} direction={sortDirection} />
              </th>
              <th className="py-3 px-4 font-medium hidden sm:table-cell" title="Weeks to recoup (for recouped shows) or trend (for in-progress shows)">Time to Recoup</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {displayShows.map((show) => {
              const designationColorClass = getDesignationColor(show.designation);
              const multiple = getProfitMultiple(show);
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
                    <RecoupedCell show={show} />
                  </td>
                  <td className="py-3 px-4">
                    <span className={designationColorClass}>{show.designation}</span>
                  </td>
                  <td className="py-3 px-4">
                    {formatEstimatedCurrency(show.capitalization)}
                  </td>
                  <td className="py-3 px-4 hidden md:table-cell">
                    {formatCurrency(show.weeklyGross)}
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    {formatCurrency(show.totalGross ?? null)}
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    {multiple !== null ? (
                      <span className="text-emerald-400 font-medium">~{multiple.toFixed(1)}x</span>
                    ) : (
                      <span className="text-gray-500">—</span>
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
