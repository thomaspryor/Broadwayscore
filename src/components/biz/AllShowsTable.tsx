'use client';

/**
 * AllShowsTable - Full sortable table of shows with commercial data
 * (/biz running shows, /biz/season/[season] all shows).
 * Sprint 2, Task 2.6. % Recouped / Return columns added Sprint A (task #158).
 * BRO-4623: Return shows only a reported investor multiple (never the model);
 * closed shows with a final designation show no model figures; closed TBD
 * reads "Undisclosed".
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  getDesignationSortOrder,
  getTrendColor,
  getTrendIcon,
} from '@/config/commercial';
import type { CommercialShowRow } from '@/lib/data-types';
import { formatCurrency, formatCapitalization } from '@/lib/biz-format';
import {
  getRecoupmentDisplayMode,
  getDesignationDisplay,
  publicSourceText,
  isClosedWithoutRecouping,
} from '@/lib/commercial-display';
import { isRunningStatus } from '@/lib/commercial-metrics';
import RecoupmentProgressBar from '@/components/RecoupmentProgressBar';

interface AllShowsTableProps {
  shows: CommercialShowRow[];
  initialLimit?: number;
}

type SortColumn = 'title' | 'designation' | 'capitalization' | 'gross' | 'cost' | 'totalGross' | 'recoupment' | 'return';
type SortDirection = 'asc' | 'desc';

const RECOUPED_SORT_VALUE = 1_000_000;

/** Sort key for the % Recouped column. Mirrors what RecoupedCell renders, so
 *  a row showing "—" never sorts as if it had a number. Recouped shows sort
 *  above every estimate without consulting the (hidden) model. */
function getRecoupedSortValue(show: CommercialShowRow): number {
  const mode = getRecoupmentDisplayMode(show);
  if (mode === 'announced') return RECOUPED_SORT_VALUE;
  if (mode === 'model') return show.modelRecoupmentPct![1];
  return -Infinity;
}

function formatMultiple(m: number): string {
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}x`;
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

/** % Recouped cell: a recoupment record renders solid + a citation marker
 *  (plus "Not publicly announced" when it was never announced, matching the
 *  show page); a modeled estimate renders the shared progress bar (labelled
 *  "Est."); a closed Fizzle or Flop says "Did not recoup"
 *  (isClosedWithoutRecouping); anything else renders "—". */
function RecoupedCell({ show }: { show: CommercialShowRow }) {
  const displayMode = getRecoupmentDisplayMode(show);

  if (displayMode === 'announced') {
    const source = publicSourceText(show.recoupedSource);
    return (
      <div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold text-sm">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Recouped
          </span>
          {source && (
            <span
              className="text-gray-500 cursor-help"
              title={`Source: ${source}`}
              aria-label={`Source: ${source}`}
            >
              <CitationIcon />
            </span>
          )}
        </div>
        {show.recoupmentNotAnnounced && (
          <div className="text-xs text-gray-500 whitespace-nowrap" data-testid="recoupment-not-announced">
            Not publicly announced
          </div>
        )}
      </div>
    );
  }

  if (displayMode === 'model' && show.modelRecoupmentPct) {
    return (
      <div className="w-36 sm:w-40" title="Model estimate, not a reported figure. See methodology.">
        <RecoupmentProgressBar estimatedPct={show.modelRecoupmentPct} modelMethod={show.modelMethod} />
      </div>
    );
  }

  if (isClosedWithoutRecouping(show)) {
    return <span className="text-gray-400 text-sm">Did not recoup</span>;
  }

  return <span className="text-gray-500">—</span>;
}

export default function AllShowsTable({ shows, initialLimit = 10 }: AllShowsTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('designation');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expanded, setExpanded] = useState(false);

  // Return column only when at least one row has a reported multiple.
  const showReturnColumn = shows.some((s) => s.reportedMultiple != null);

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
        case 'cost':
          comparison = (a.weeklyCost ?? -Infinity) - (b.weeklyCost ?? -Infinity);
          break;
        case 'totalGross':
          comparison = (a.totalGross ?? -Infinity) - (b.totalGross ?? -Infinity);
          break;
        case 'recoupment':
          comparison = getRecoupedSortValue(a) - getRecoupedSortValue(b);
          break;
        case 'return':
          comparison = (a.reportedMultiple ?? -Infinity) - (b.reportedMultiple ?? -Infinity);
          break;
      }
      if (Number.isNaN(comparison)) comparison = 0; // -Infinity - -Infinity
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
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('title')}
                aria-sort={sortColumn === 'title' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Show
                <SortIcon active={sortColumn === 'title'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('recoupment')}
                aria-sort={sortColumn === 'recoupment' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                title="Recouped when trade press or an SEC filing reports it. Otherwise our model's estimate, with its range."
              >
                % Recouped
                <SortIcon active={sortColumn === 'recoupment'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('designation')}
                aria-sort={sortColumn === 'designation' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Designation
                <SortIcon active={sortColumn === 'designation'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group"
                onClick={() => handleSort('capitalization')}
                aria-sort={sortColumn === 'capitalization' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Capitalization
                <SortIcon active={sortColumn === 'capitalization'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group hidden md:table-cell"
                onClick={() => handleSort('gross')}
                aria-sort={sortColumn === 'gross' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Weekly Gross
                <SortIcon active={sortColumn === 'gross'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group hidden lg:table-cell"
                onClick={() => handleSort('cost')}
                aria-sort={sortColumn === 'cost' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                title="What the show costs to run each week. ~ marks an estimate; a reported figure has a cited source."
              >
                Weekly Cost
                <SortIcon active={sortColumn === 'cost'} direction={sortDirection} />
              </th>
              <th
                className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group hidden lg:table-cell"
                onClick={() => handleSort('totalGross')}
                aria-sort={sortColumn === 'totalGross' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                Total Gross
                <SortIcon active={sortColumn === 'totalGross'} direction={sortDirection} />
              </th>
              {showReturnColumn && (
                <th
                  className="py-3 px-4 font-medium whitespace-nowrap cursor-pointer hover:text-white transition-colors select-none group hidden sm:table-cell"
                  onClick={() => handleSort('return')}
                  aria-sort={sortColumn === 'return' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  title="Investor return multiple as reported by trade press or SEC filings. Blank when none has been reported."
                >
                  Reported Return
                  <SortIcon active={sortColumn === 'return'} direction={sortDirection} />
                </th>
              )}
              <th
                className="py-3 px-4 font-medium whitespace-nowrap hidden sm:table-cell"
                title="Recouped shows: weeks from opening night to the reported recoupment date (mid-month when only the month was reported; blank when only the year was). Running shows: average gross of the last 4 weeks vs the 4 weeks before."
              >
                Time to Recoup
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {displayShows.map((show) => {
              const designation = getDesignationDisplay(show.designation, show.status);
              const running = isRunningStatus(show.status);
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
                    <span className={designation.textClass} title={designation.description}>
                      {designation.label}
                    </span>
                    {show.nonprofitOrg && (
                      <div className="text-xs text-gray-500">{show.nonprofitOrg}</div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    {show.capitalization == null ? (
                      <span className="text-gray-500">Undisclosed</span>
                    ) : (
                      formatCapitalization(show.capitalization, show.capitalizationIsEstimate)
                    )}
                  </td>
                  <td className="py-3 px-4 hidden md:table-cell">
                    {running ? (
                      <>
                        <div>{formatCurrency(show.weeklyGross)}</div>
                        {(show.weeklyCapacity != null || show.weeklyAtp != null) && (
                          <div className="text-xs text-gray-500 whitespace-nowrap" title="Latest week: share of seats sold (can top 100% with standing room), and average ticket price">
                            {[
                              show.weeklyCapacity != null ? `${Math.round(show.weeklyCapacity)}% full` : null,
                              show.weeklyAtp != null ? `$${Math.round(show.weeklyAtp)} avg` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-gray-500">Closed</span>
                    )}
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    {show.weeklyCost == null ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      `${show.weeklyCostIsEstimate ? '~' : ''}${formatCurrency(show.weeklyCost)}`
                    )}
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    {formatCurrency(show.totalGross ?? null)}
                  </td>
                  {showReturnColumn && (
                    <td className="py-3 px-4 hidden sm:table-cell">
                      {show.reportedMultiple != null ? (
                        <span className="text-emerald-400 font-medium">{formatMultiple(show.reportedMultiple)}</span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                  )}
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <span
                      className={getTrendColor(show.trend, show.recouped)}
                      aria-label={show.recouped ? 'Recouped' : running ? show.trend : 'Not running'}
                    >
                      {show.recouped
                        ? show.recoupedWeeks
                          ? `~${show.recoupedWeeks} wks`
                          : '—'
                        : running
                          ? getTrendIcon(show.trend, show.recouped)
                          : '—'}
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
            Showing {displayShows.length} of {shows.length} shows ·{' '}
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
