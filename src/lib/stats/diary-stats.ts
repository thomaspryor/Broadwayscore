/**
 * computeDiaryStats — the hero tiles, the shows-per-year chart, and the
 * records strip beneath it (spec §3.1, §3.2).
 *
 * Pure: everything it needs arrives as arguments. Rows with a null `date_seen`
 * still count toward totals, distinct theaters and hours-in-a-seat, but are
 * excluded from every date bucket (year, month, streak, drought) — a diary
 * entry with no date can't be placed on a timeline.
 */

import type { DiaryRow, ShowMetaIndex } from './types';
import {
  monthKey,
  monthsBetween,
  nextMonth,
  parseRating,
  resolveRuntimeMinutes,
  yearOf,
} from './parse';
import { buildHouseIndex, matchVenueToHouse, normalizeForMatch } from './venue-match';
import type { HouseIndex } from './venue-match';

export interface YearBucket {
  year: number;
  count: number;
}

export interface MonthBucket {
  /** "YYYY-MM" */
  month: string;
  count: number;
}

export interface DroughtSpan {
  months: number;
  /** First empty month, "YYYY-MM". */
  from: string;
  /** Last empty month, "YYYY-MM". */
  to: string;
}

export interface DiaryStats {
  /** Every row, including undated and unrated ones. */
  total: number;
  rated: number;
  unrated: number;
  dated: number;
  undated: number;

  /** Σ runtime across all rows. */
  minutesInSeat: number;
  hoursInSeat: number;
  /** Rows that used the 2h30m/2h type default because no runtime was known. */
  runtimeFallbackCount: number;
  /** runtimeFallbackCount / total, 0 when the diary is empty. */
  runtimeFallbackShare: number;

  /** Distinct normalized venues, Broadway house or not. */
  distinctTheaters: number;
  /** Distinct venues that resolved to an operating Broadway house. */
  distinctBroadwayHouses: number;

  /** Ascending, gaps between the first and last year filled with 0. */
  byYear: YearBucket[];
  /** Ascending, gaps between the first and last month filled with 0. */
  byMonth: MonthBucket[];

  busiestMonth: MonthBucket | null;
  /** Consecutive months with ≥1 show, counting back from the anchor month. */
  currentStreak: number;
  /** Longest run of empty months strictly between the first and last show. */
  longestDrought: DroughtSpan | null;

  firstSeen: string | null;
  lastSeen: string | null;
}

export interface DiaryStatsOptions {
  /**
   * Operating Broadway house names — the keys of data/theater-metadata.json.
   * Omit to skip the Broadway-house count (distinctBroadwayHouses stays 0).
   */
  houseNames?: string[];
  /** Prebuilt index; takes precedence over houseNames. */
  houseIndex?: HouseIndex;
  /**
   * "YYYY-MM-DD". Anchors the current streak. Defaults to the latest dated
   * row, which makes the function deterministic in tests.
   */
  today?: string;
}

/**
 * The month the current streak counts back from.
 *
 * A streak stays alive through the current month even before you've seen
 * anything in it: anchor on `today`'s month if it has a show, otherwise on the
 * previous month if that one does, otherwise there is no live streak. Anything
 * older than one empty month has lapsed.
 */
function resolveStreakAnchor(counts: Map<string, number>, todayMonth: string): string | null {
  if ((counts.get(todayMonth) ?? 0) > 0) return todayMonth;
  const prev = previousMonth(todayMonth);
  if ((counts.get(prev) ?? 0) > 0) return prev;
  return null;
}

function previousMonth(key: string): string {
  const [y, m] = key.split('-').map((v) => parseInt(v, 10));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function computeDiaryStats(
  rows: DiaryRow[],
  showMeta: ShowMetaIndex = {},
  opts: DiaryStatsOptions = {}
): DiaryStats {
  const index =
    opts.houseIndex ?? (opts.houseNames ? buildHouseIndex(opts.houseNames) : null);

  const monthCounts = new Map<string, number>();
  const yearCounts = new Map<number, number>();
  const venueKeys = new Set<string>();
  const houses = new Set<string>();

  let rated = 0;
  let minutes = 0;
  let fallbacks = 0;
  let dated = 0;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  for (const row of rows) {
    const meta = showMeta[row.show_id];

    if (parseRating(row.rating) !== null) rated++;

    const rt = resolveRuntimeMinutes(meta);
    minutes += rt.minutes;
    if (rt.fallback) fallbacks++;

    const vKey = normalizeForMatch(meta?.venue);
    if (vKey) {
      venueKeys.add(vKey);
      if (index) {
        const house = matchVenueToHouse(meta?.venue, index, { category: meta?.category });
        if (house) houses.add(house);
      }
    }

    const mk = monthKey(row.date_seen);
    const yr = yearOf(row.date_seen);
    if (mk && yr !== null) {
      dated++;
      monthCounts.set(mk, (monthCounts.get(mk) ?? 0) + 1);
      yearCounts.set(yr, (yearCounts.get(yr) ?? 0) + 1);
      const d = row.date_seen as string;
      if (firstSeen === null || d < firstSeen) firstSeen = d;
      if (lastSeen === null || d > lastSeen) lastSeen = d;
    }
  }

  const total = rows.length;

  // Year buckets, gap-filled so the bar chart has one bar per year.
  const years = Array.from(yearCounts.keys()).sort((a, b) => a - b);
  const byYear: YearBucket[] = [];
  if (years.length) {
    for (let y = years[0]; y <= years[years.length - 1]; y++) {
      byYear.push({ year: y, count: yearCounts.get(y) ?? 0 });
    }
  }

  // Month buckets, gap-filled — the drought calculation depends on the gaps
  // being materialized rather than inferred.
  const monthKeys = Array.from(monthCounts.keys()).sort();
  const byMonth: MonthBucket[] = [];
  if (monthKeys.length) {
    let cursor = monthKeys[0];
    const end = monthKeys[monthKeys.length - 1];
    // Bounded by monthsBetween so a malformed key can't spin forever.
    const span = monthsBetween(cursor, end);
    for (let i = 0; i <= span; i++) {
      byMonth.push({ month: cursor, count: monthCounts.get(cursor) ?? 0 });
      cursor = nextMonth(cursor);
    }
  }

  let busiestMonth: MonthBucket | null = null;
  for (const b of byMonth) {
    if (b.count > 0 && (busiestMonth === null || b.count > busiestMonth.count)) {
      busiestMonth = { ...b };
    }
  }

  // Current streak.
  let currentStreak = 0;
  if (monthKeys.length) {
    const todayMonth = monthKey(opts.today) ?? monthKeys[monthKeys.length - 1];
    let cursor = resolveStreakAnchor(monthCounts, todayMonth);
    while (cursor && (monthCounts.get(cursor) ?? 0) > 0) {
      currentStreak++;
      cursor = previousMonth(cursor);
    }
  }

  // Longest drought — the longest run of empty months strictly inside the
  // diary's span. Leading/trailing emptiness isn't a drought, it's "before you
  // started" / "since your last show".
  let longestDrought: DroughtSpan | null = null;
  let runStart: string | null = null;
  let runLen = 0;
  let runEnd: string | null = null;
  for (const b of byMonth) {
    if (b.count === 0) {
      if (runStart === null) runStart = b.month;
      runEnd = b.month;
      runLen++;
    } else {
      if (runStart && runEnd && (longestDrought === null || runLen > longestDrought.months)) {
        longestDrought = { months: runLen, from: runStart, to: runEnd };
      }
      runStart = null;
      runEnd = null;
      runLen = 0;
    }
  }

  return {
    total,
    rated,
    unrated: total - rated,
    dated,
    undated: total - dated,
    minutesInSeat: minutes,
    hoursInSeat: Math.round((minutes / 60) * 10) / 10,
    runtimeFallbackCount: fallbacks,
    runtimeFallbackShare: total > 0 ? fallbacks / total : 0,
    distinctTheaters: venueKeys.size,
    distinctBroadwayHouses: houses.size,
    byYear,
    byMonth,
    busiestMonth,
    currentStreak,
    longestDrought,
    firstSeen,
    lastSeen,
  };
}
