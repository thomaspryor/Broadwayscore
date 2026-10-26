/**
 * Stats scope pill model — All time · Tony seasons · Years.
 *
 * Port of the iOS app's lib/stats-scope.ts (BRO-6170 prototype). Pure: the
 * pill and every module read the same ScopeOption, so a module can never
 * disagree with the pill about which rows it shows.
 *
 * Season scopes always carry the word "Tony" ("Tony season 2025-26") so they
 * never read like Browse's Tony-ELIGIBILITY period filter, a different range.
 */

import type { DiaryRow, StatsCanon } from '@/lib/stats';
import { seasonWindows, seasonForDate, type SeasonWindow } from '@/lib/stats';

export type ScopeKind = 'all' | 'season' | 'year';

export interface ScopeOption {
  /** Stable identity: "all", "season:2025-26", "year:2026". */
  id: string;
  kind: ScopeKind;
  label: string;
  section: 'All time' | 'Seasons' | 'Years';
  season?: string;
  year?: number;
  /** Inclusive bounds, "YYYY-MM-DD"; null = unbounded. */
  start: string | null;
  end: string | null;
  /** True for the in-progress season / current calendar year. */
  inProgress: boolean;
}

export const ALL_TIME: ScopeOption = {
  id: 'all',
  kind: 'all',
  label: 'All time',
  section: 'All time',
  start: null,
  end: null,
  inProgress: false,
};

function seasonOption(w: SeasonWindow): ScopeOption {
  return {
    id: `season:${w.label}`,
    kind: 'season',
    label: `Tony season ${w.label}`,
    section: 'Seasons',
    season: w.label,
    start: w.start,
    end: w.end,
    inProgress: w.provisional,
  };
}

function yearOption(year: number, currentYear: number): ScopeOption {
  return {
    id: `year:${year}`,
    kind: 'year',
    label: String(year),
    section: 'Years',
    year,
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    inProgress: year === currentYear,
  };
}

/** Local calendar date as "YYYY-MM-DD" (never UTC: date_seen has no TZ). */
export function localToday(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * All time, then seasons the diary touches (newest first), then calendar
 * years it touches (newest first). The current season always appears so the
 * quick toggle has somewhere to go.
 */
export function buildScopes(
  rows: DiaryRow[],
  canon: StatsCanon,
  opts: { today?: string; limit?: number } = {},
): ScopeOption[] {
  const today = opts.today ?? localToday();
  const limit = opts.limit ?? 12;
  const windows = seasonWindows(canon, { today });

  const seasonHits = new Set<string>();
  const yearHits = new Set<number>();
  for (const row of rows) {
    if (!row.date_seen) continue;
    const y = parseInt(row.date_seen.slice(0, 4), 10);
    if (Number.isFinite(y)) yearHits.add(y);
    const w = seasonForDate(windows, row.date_seen);
    if (w) seasonHits.add(w.label);
  }
  const current = seasonForDate(windows, today);
  if (current) seasonHits.add(current.label);

  const seasons = windows
    .filter((w) => seasonHits.has(w.label))
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .slice(0, limit)
    .map(seasonOption);

  const currentYear = parseInt(today.slice(0, 4), 10);
  const years = Array.from(yearHits)
    .sort((a, b) => b - a)
    .slice(0, limit)
    .map((y) => yearOption(y, currentYear));

  return [ALL_TIME, ...seasons, ...years];
}

/** Undated rows are in All time only. */
export function inScope(scope: ScopeOption, dateSeen: string | null | undefined): boolean {
  if (scope.kind === 'all') return true;
  if (!dateSeen) return false;
  if (scope.start !== null && dateSeen < scope.start) return false;
  if (scope.end !== null && dateSeen > scope.end) return false;
  return true;
}

export function filterRows<T extends { date_seen: string | null }>(rows: T[], scope: ScopeOption): T[] {
  if (scope.kind === 'all') return rows;
  return rows.filter((r) => inScope(scope, r.date_seen));
}

/** Fourth hero tile label: literal, never mixes a season and calendar frame. */
export function periodTileLabel(scope: ScopeOption): string {
  switch (scope.kind) {
    case 'season':
      return scope.inProgress ? 'This season so far' : `${scope.season} season`;
    case 'year':
      return scope.inProgress ? `${scope.year} so far` : `In ${scope.year}`;
    default:
      return 'Years logged';
  }
}

/** Sentence fragment for module copy: " in the 2025-26 Tony season". */
export function scopeSuffix(scope: ScopeOption): string {
  switch (scope.kind) {
    case 'season':
      return ` in the ${scope.season} Tony season`;
    case 'year':
      return ` in ${scope.year}`;
    default:
      return '';
  }
}
