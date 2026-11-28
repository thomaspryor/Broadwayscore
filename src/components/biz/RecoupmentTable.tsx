'use client';

/**
 * RecoupmentTable - Sortable table for recent recoupments
 * Sprint 2, Task 2.5
 */

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import { openRowLink } from '@/lib/row-click';
import { formatCapitalization } from '@/lib/biz-format';

interface RecoupmentShow {
  slug: string;
  title: string;
  season: string;
  /** null when only the recoupment year is known (see calculateWeeksToRecoup). */
  weeksToRecoup: number | null;
  /** weeksToRecoup is our estimate, not a measured figure: prints "est.". */
  weeksIsEstimate: boolean;
  weeksEstimateNote: string | null;
  /** The recoupment was reported after the Broadway run closed. Only the report month is known, so no weeks-from-opening figure applies. */
  reportedAfterClosing: boolean;
  capitalization: number | null;
  /** Prints the "~" estimate mark only when true (isEstimatedCapitalization). */
  capitalizationIsEstimate: boolean;
  capitalizationIsMaximum: boolean;
  recoupDate: string;
  recoupDateIsEstimate: boolean;
}

interface RecoupmentTableProps {
  shows: RecoupmentShow[];
}

type SortColumn = 'title' | 'weeks' | 'capitalization' | 'date';
type SortDirection = 'asc' | 'desc';

const WEEKS_TOOLTIP =
  'Weeks from opening night to the reported recoupment date (the middle of the month when only the month was reported). Shows marked "est." show our own estimate, counted from opening night to closing. Other shows whose recoupment was reported after their Broadway run closed read "Reported after closing": the report month is the only date known, so weeks cannot be measured. Blank when only the year was reported.';

function formatDate(dateStr: string): string {
  // Input: "2025-01", "2024-06", or "2026" (year-only when exact month unknown)
  const [year, month] = dateStr.split('-');
  if (!month) return year;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month) - 1]} ${year}`;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return (
      <span className="ml-1 text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity">
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
  const router = useRouter();
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
      // Unknown week counts sort last in either direction.
      if (sortColumn === 'weeks' && (a.weeksToRecoup === null || b.weeksToRecoup === null)) {
        if (a.weeksToRecoup === b.weeksToRecoup) return 0;
        return a.weeksToRecoup === null ? 1 : -1;
      }
      let comparison = 0;
      switch (sortColumn) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'weeks':
          comparison = (a.weeksToRecoup as number) - (b.weeksToRecoup as number);
          break;
        case 'capitalization':
          comparison = (a.capitalization ?? -Infinity) - (b.capitalization ?? -Infinity);
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
        <p className="text-fg-muted">No recent recoupments</p>
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
                title={WEEKS_TOOLTIP}
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
                Reported
                <SortIcon active={sortColumn === 'date'} direction={sortDirection} />
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {sortedShows.map((show) => (
              <tr
                key={show.slug}
                className="group border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer"
                onClick={(e) => openRowLink(e, `/show/${show.slug}`, router.push)}
                onAuxClick={(e) => openRowLink(e, `/show/${show.slug}`, router.push)}
              >
                <td className="py-3 px-4">
                  <Link
                    href={`/show/${show.slug}`}
                    className="font-medium text-white group-hover:text-brand transition-colors"
                  >
                    <RowLinkArrow label={show.title} />
                  </Link>
                </td>
                <td className="py-3 px-4 text-gray-400 hidden sm:table-cell">
                  {show.season}
                </td>
                <td className="py-3 px-4">
                  {show.weeksToRecoup === null && show.reportedAfterClosing ? (
                    <span className="text-gray-400" title="The recoupment was reported after the Broadway run closed, and the report month is the only date known, so weeks from opening cannot be measured">Reported after closing</span>
                  ) : show.weeksToRecoup === null ? (
                    <span className="text-fg-muted" title="Only the year of recoupment was reported">—</span>
                  ) : show.weeksIsEstimate ? (
                    <span title={show.weeksEstimateNote ?? undefined}>
                      <span className="text-emerald-400/60 font-semibold">~{show.weeksToRecoup}</span>{' '}
                      <span className="text-xs text-fg-muted">est.</span>
                    </span>
                  ) : (
                    <span className="text-emerald-400 font-semibold">~{show.weeksToRecoup}</span>
                  )}
                </td>
                <td className="py-3 px-4">{formatCapitalization(show.capitalization, show.capitalizationIsEstimate, show.capitalizationIsMaximum)}</td>
                <td className="py-3 px-4 text-fg-muted hidden sm:table-cell">
                  {show.recoupDateIsEstimate ? '~' : ''}{formatDate(show.recoupDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
