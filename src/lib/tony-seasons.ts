/**
 * Tony season definitions and date-range helpers for the Time Period filter.
 *
 * Per-year cutoffs come from src/lib/tony-cutoffs.ts (single source of truth,
 * cited from Tony Awards Administration Committee announcements). COVID-era
 * seasons (2019-20, 2020-21, 2021-22) use the actual COVID-affected windows.
 *
 * The Time Period filter compares show.openingDate (ISO YYYY-MM-DD) directly
 * against these ranges — string comparison is correct because ISO 8601 dates
 * sort lexicographically.
 */
import { TONY_CUTOFFS } from '@/lib/tony-cutoffs';

export interface DateRange {
  from: string;
  to: string;
}

export interface RangeDef {
  id: string;
  label: string;
  from: string;
  to: string;
}

/**
 * 8 most recent Tony seasons, newest first.
 *
 * Sourced from TONY_CUTOFFS (canonical per-year start/end dates with citations).
 * The label uses an en-dash for display ("2025–26") while TONY_CUTOFFS stores
 * the canonical short form ("2025-26") that matches awards.json season fields
 * and our URL conventions.
 */
export const TONY_SEASONS: RangeDef[] = TONY_CUTOFFS
  .slice()
  .reverse()
  .slice(0, 8)
  .map((s) => ({
    id: s.label,
    label: s.label.replace('-', '–'),
    from: s.start,
    to: s.end,
  }));

/** Decade pills — calendar-year ranges. */
export const DECADES: RangeDef[] = [
  { id: '2010s', label: '2010s', from: '2010-01-01', to: '2019-12-31' },
  { id: '2000s', label: '2000s', from: '2000-01-01', to: '2009-12-31' },
  { id: '1990s', label: '1990s', from: '1990-01-01', to: '1999-12-31' },
  { id: '1980s', label: '1980s', from: '1980-01-01', to: '1989-12-31' },
  { id: '1970s', label: '1970s', from: '1970-01-01', to: '1979-12-31' },
  { id: '1960s', label: '1960s', from: '1960-01-01', to: '1969-12-31' },
  { id: 'pre-1960', label: 'Pre-1960', from: '1950-01-01', to: '1959-12-31' },
];

export const SLIDER_MIN_YEAR = 1950;
// Module-load year — used only as the upper bound on the custom-range slider.
// See note on TONY_SEASONS for the static-export staleness consideration.
export const SLIDER_MAX_YEAR = new Date().getFullYear();

export function rangesEqual(a: DateRange, b: DateRange): boolean {
  return a.from === b.from && a.to === b.to;
}

export function findSeason(range: DateRange): RangeDef | null {
  return TONY_SEASONS.find((s) => rangesEqual(s, range)) ?? null;
}

export function findDecade(range: DateRange): RangeDef | null {
  return DECADES.find((d) => rangesEqual(d, range)) ?? null;
}

/** True when every range in the array is one of the Tony season presets. */
export function isAllSeasons(ranges: DateRange[]): boolean {
  return ranges.length > 0 && ranges.every((r) => findSeason(r) !== null);
}

/** Calendar-year range as ISO date range (Jan 1 → Dec 31). */
export function yearsToDateRange(from: number, to: number): DateRange {
  return { from: `${from}-01-01`, to: `${to}-12-31` };
}

/** Inverse of yearsToDateRange — returns null if the range isn't a clean Jan-1/Dec-31 span. */
export function dateRangeToYears(range: DateRange): { from: number; to: number } | null {
  const fromY = parseInt(range.from.slice(0, 4), 10);
  const toY = parseInt(range.to.slice(0, 4), 10);
  if (isNaN(fromY) || isNaN(toY)) return null;
  if (range.from !== `${fromY}-01-01` || range.to !== `${toY}-12-31`) return null;
  return { from: fromY, to: toY };
}

/**
 * Best human label for a range chip:
 *   season match → "2024–25"
 *   decade match → "2010s"
 *   clean year span → "2015" / "2010–2015"
 *   anything else → "2024-04-28 → 2025-04-27"
 */
export function labelForRange(range: DateRange): string {
  const season = findSeason(range);
  if (season) return season.label;
  const decade = findDecade(range);
  if (decade) return decade.label;
  const years = dateRangeToYears(range);
  if (years) {
    return years.from === years.to ? String(years.from) : `${years.from}–${years.to}`;
  }
  return `${range.from} → ${range.to}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `?dates=YYYY-MM-DD~YYYY-MM-DD,YYYY-MM-DD~YYYY-MM-DD` */
export function parseDateRanges(raw: string | null | undefined): DateRange[] {
  if (!raw) return [];
  const out: DateRange[] = [];
  for (const part of raw.split(',')) {
    const segs = part.split('~');
    if (segs.length !== 2) continue;
    const [from, to] = segs;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) continue;
    if (from > to) continue;
    out.push({ from, to });
  }
  return out;
}

export function serializeDateRanges(ranges: DateRange[]): string {
  return ranges.map((r) => `${r.from}~${r.to}`).join(',');
}
