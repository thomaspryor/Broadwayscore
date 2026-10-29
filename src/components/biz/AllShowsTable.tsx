'use client';

/**
 * AllShowsTable - Full sortable table of shows with commercial data
 * (/biz running shows, /biz/season/[season] all shows).
 * Sprint 2, Task 2.6. % Recouped / Return columns added Sprint A (task #158).
 * BRO-4623: Return shows only a reported investor multiple (never the model);
 * closed TBD reads "Undisclosed". BRO-5502: % Recouped always says something
 * (getRecoupedCellSummary): a record, a reported return, the analyst's or our
 * model's labelled estimate, a loss phrase, or the reason there is none.
 */

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import { openRowLink } from '@/lib/row-click';
import {
  getDesignationSortOrder,
  getTrendColor,
  getTrendIcon,
} from '@/config/commercial';
import type { CommercialShowRow } from '@/lib/data-types';
import { formatCurrency, formatCapitalization, weeklyCostLabel } from '@/lib/biz-format';
import {
  getRecoupedCellSummary,
  getDesignationDisplay,
  getNonprofitTag,
  publicSourceText,
  sourceTextLink,
  LOSS_ON_SILENCE_CAVEAT,
  DESIGNATION_ESTIMATE_CAVEAT,
  LIKELY_OUTCOME_NOTE,
  type RecoupedCellSummary,
  formatReturnRange,
} from '@/lib/commercial-display';
import { isRunningStatus } from '@/lib/commercial-metrics';
import RecoupmentProgressBar from '@/components/RecoupmentProgressBar';
import AnalystEstimateCredit from '@/components/biz/AnalystEstimateCredit';

interface AllShowsTableProps {
  shows: CommercialShowRow[];
  initialLimit?: number;
}

type SortColumn = 'title' | 'designation' | 'capitalization' | 'gross' | 'cost' | 'totalGross' | 'recoupment' | 'return';
type SortDirection = 'asc' | 'desc';

const RECOUPED_SORT_VALUE = 1_000_000;

/** Sort key for the % Recouped column, from the same summary RecoupedCell
 *  renders, so a row without a figure never sorts as if it had one. Recouped
 *  shows sort above every estimate; a range sorts by its middle; a known loss
 *  with no figure sorts below every figure but above rows we know nothing about. */
function getRecoupedSortValue(show: CommercialShowRow): number {
  const cell = getRecoupedCellSummary(show);
  if (cell.kind === 'recouped') return RECOUPED_SORT_VALUE;
  if (cell.kind === 'reported') return (cell.lo + cell.hi) / 2;
  if (cell.kind === 'analyst') return (cell.range[0] + cell.range[1]) / 2;
  if (cell.kind === 'model') return cell.pct[1];
  if (cell.kind === 'loss') return -1;
  // A model-labelled win prints its return range in place of the reason (BRO-6555).
  if (show.estimatedReturnRange) return RECOUPED_SORT_VALUE;
  return -Infinity;
}

function formatMultiple(m: number): string {
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}x`;
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

function CitationIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5M10.172 13.828a4 4 0 010-5.656l3-3a4 4 0 015.656 5.656l-1.5 1.5" />
    </svg>
  );
}

/** Our modeled investor return under a win (BRO-6555): always a range, always "Est." */
function EstimatedReturnLine({ show }: { show: CommercialShowRow }) {
  const range = show.estimatedReturnRange;
  if (!range) return null;
  const assumed = show.modelDataQuality === 'low';
  return (
    <div
      className="mt-0.5"
      data-testid="estimated-return"
      title={`Our model's estimate of what investors got back, as a multiple of their money, after the producers' share and counting the NY tax credit. Shown as a range because running costs are rarely reported${assumed ? '; this show\'s running cost is assumed from similar shows' : ''}. See methodology.`}
    >
      <div className="text-xs text-gray-300 whitespace-nowrap">Est. {formatReturnRange(range)} returned</div>
      <div className="text-[10px] text-fg-muted whitespace-nowrap">Our model{assumed ? ' · running cost assumed' : ''}</div>
    </div>
  );
}

/** % Recouped cell, one branch per getRecoupedCellSummary kind: a recoupment
 *  record renders solid + a citation marker (plus "Not publicly announced"
 *  when it was never announced, matching the show page); a reported return
 *  names its outlet; an estimate renders the shared progress bar (labelled
 *  "Est.", the analyst's with a credit line to the post); a closed Fizzle or
 *  Flop says lossOutcomePhrase(…, 'cell'); otherwise the reason there is no
 *  figure. */
function RecoupedCell({ show }: { show: CommercialShowRow }) {
  const cell: RecoupedCellSummary = getRecoupedCellSummary(show);

  if (cell.kind === 'recouped') {
    // The tooltip and screen-reader label read the citation, not its raw URLs.
    const publicSource = publicSourceText(show.recoupedSource);
    const source = publicSource ? sourceTextLink(publicSource, null).label : null;
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
              className="text-fg-muted cursor-help"
              title={`Source: ${source}`}
              aria-label={`Source: ${source}`}
            >
              <CitationIcon />
            </span>
          )}
        </div>
        {show.recoupmentNotAnnounced && (
          <div className="text-xs text-fg-muted whitespace-nowrap" data-testid="recoupment-not-announced">
            Not publicly announced
          </div>
        )}
        <EstimatedReturnLine show={show} />
      </div>
    );
  }

  if (cell.kind === 'reported') {
    const figure = cell.hi === 0 ? '0%' : cell.lo === cell.hi ? `${cell.lo}%` : `${cell.lo}–${cell.hi}%`;
    return (
      <div title={`Reported by ${cell.outlet}${cell.asOf ? `, ${cell.asOf}` : ''}`}>
        <div className="text-sm text-gray-200 whitespace-nowrap">{figure} returned</div>
        <div className="text-[10px] text-fg-muted whitespace-nowrap">Reported · {cell.outlet}</div>
      </div>
    );
  }

  if (cell.kind === 'analyst') {
    const title = cell.ours
      ? 'Our own estimate, not a reported figure. See methodology.'
      : cell.withModel
      ? `Range spanning an r/Broadway analyst's estimate (u/Boring_Waltz_9545) and our model, not a reported figure. See methodology.`
      : `Estimate published by an r/Broadway analyst (u/Boring_Waltz_9545), not a reported figure. See methodology.`;
    if (cell.range[0] >= 100) {
      return (
        <div title={title}>
          <div className="text-xs text-gray-300">Est. recouped, not yet announced</div>
          <AnalystEstimateCredit asOf={cell.asOf} url={cell.url} withModel={cell.withModel} ours={cell.ours} compact />
        </div>
      );
    }
    return (
      <div className="w-36 sm:w-40" title={title}>
        <RecoupmentProgressBar estimatedPct={cell.range} />
        <AnalystEstimateCredit asOf={cell.asOf} url={cell.url} withModel={cell.withModel} ours={cell.ours} compact />
      </div>
    );
  }

  if (cell.kind === 'model') {
    return (
      <div className="w-36 sm:w-40" title="Our model estimate, not a reported figure. See methodology.">
        <RecoupmentProgressBar estimatedPct={cell.pct} modelMethod={show.modelMethod} belowCosts={show.modelBelowCosts} final={show.status === 'closed'} />
      </div>
    );
  }

  if (cell.kind === 'loss') {
    return <span className="text-gray-400 text-sm">{cell.text}</span>;
  }

  // A win label our model gave (no recoupment record): show what it rests on.
  if (show.estimatedReturnRange) return <EstimatedReturnLine show={show} />;

  return <span className="text-gray-400 text-xs" data-testid="model-hold">{cell.text}</span>;
}

export default function AllShowsTable({ shows, initialLimit = 10 }: AllShowsTableProps) {
  const router = useRouter();
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
        <p className="text-fg-muted">No commercial data available</p>
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
                title="Recouped shows: weeks from opening night to the reported recoupment date (mid-month when only the month was reported; blank when only the year was; Reported after closing when the recoupment was reported after the run ended, so weeks cannot be measured; est. marks our own estimate, counted from opening night to closing). Running shows: average gross of the last 4 weeks vs the 4 weeks before."
              >
                Time to Recoup
              </th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {displayShows.map((show) => {
              const designation = getDesignationDisplay(show.designation, show.status, show.recouped);
              const running = isRunningStatus(show.status);
              return (
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
                  <td className="py-3 px-4">
                    <RecoupedCell show={show} />
                  </td>
                  <td className="py-3 px-4">
                    <span className={designation.textClass} title={show.lossCaveat ?? designation.description}>
                      {designation.label}
                    </span>
                    {show.nonprofitOrg && (
                      <div className="text-xs text-fg-muted">{getNonprofitTag(show)}</div>
                    )}
                    {show.lossCaveat && (
                      <div className="text-xs text-fg-muted whitespace-nowrap" title={show.lossCaveat === DESIGNATION_ESTIMATE_CAVEAT ? DESIGNATION_ESTIMATE_CAVEAT : LOSS_ON_SILENCE_CAVEAT} data-testid="loss-basis-tag">
                        {show.lossCaveat === DESIGNATION_ESTIMATE_CAVEAT ? 'Our estimate' : 'No recoupment announced'}
                      </div>
                    )}
                    {show.likelyOutcome && (
                      <div className="text-xs text-gray-300 whitespace-nowrap" title={LIKELY_OUTCOME_NOTE[show.likelyOutcomeBasis ?? 'model']} data-testid="likely-outcome">
                        {show.likelyOutcome}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    {show.capitalization == null ? (
                      <span className="text-fg-muted">Undisclosed</span>
                    ) : (
                      formatCapitalization(show.capitalization, show.capitalizationIsEstimate, show.capitalizationIsMaximum)
                    )}
                  </td>
                  <td className="py-3 px-4 hidden md:table-cell">
                    {running ? (
                      <>
                        <div>{formatCurrency(show.weeklyGross)}</div>
                        {(show.weeklyCapacity != null || show.weeklyAtp != null) && (
                          <div className="text-xs text-fg-muted whitespace-nowrap" title="Latest week: share of seats sold (can top 100% with standing room), and average ticket price">
                            {[
                              show.weeklyCapacity != null ? `${Math.round(show.weeklyCapacity)}% full` : null,
                              show.weeklyAtp != null ? `$${Math.round(show.weeklyAtp)} avg` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-fg-muted">Closed</span>
                    )}
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    {show.weeklyCost == null ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      <>
                        {`${show.weeklyCostIsEstimate ? '~' : ''}${formatCurrency(show.weeklyCost)}`}
                        {show.weeklyCostBasis && show.weeklyCostBasis !== 'running' && (
                          <span className="block text-[10px] text-fg-muted">{weeklyCostLabel(show.weeklyCostBasis)}</span>
                        )}
                      </>
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
                        <span className="text-fg-muted">—</span>
                      )}
                    </td>
                  )}
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <span
                      className={getTrendColor(show.trend, show.recouped)}
                      aria-label={show.recouped ? (show.recoupedWeeksIsEstimate ? 'Recouped, estimated weeks' : 'Recouped') : running ? show.trend : 'Not running'}
                    >
                      {show.recouped
                        ? show.recoupedWeeks
                          ? `~${show.recoupedWeeks} wks${show.recoupedWeeksIsEstimate ? ' est.' : ''}`
                          : show.recoupReportedAfterClosing
                            ? 'Reported after closing'
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
          <span className="text-fg-muted text-sm">
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
