// Box Office history derivations for the show-page Box Office Scorecard.
//
// SERVER-ONLY: imports the full grosses-history.json (~5.5 MB). Import this
// module exclusively from server components (page.tsx) and pass the small
// computed BoxOfficeHistoryStats object down as props — never import it from
// a 'use client' file or the whole history ships in the client bundle.

import historyData from '../../data/grosses-history.json';

interface HistoryWeekShow {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  seatsOffered?: number | null;
  performances: number | null;
}

interface GrossesHistoryFile {
  weeks: Record<string, Record<string, HistoryWeekShow>>;
}

const history = historyData as unknown as GrossesHistoryFile;

// Week keys sorted ascending, computed once at module load.
const sortedWeeks: string[] = Object.keys(history.weeks || {}).sort();

export interface SparklinePoint {
  weekEnding: string;
  gross: number;
}

export interface BoxOfficeHistoryStats {
  /** Up to the trailing 12 weeks with data for this show, oldest first. */
  sparkline: SparklinePoint[];
  /** Rank by gross among shows reporting in the latest week (1-based). */
  rank: number | null;
  /** Number of shows reporting a gross in the latest week. */
  rankedShows: number | null;
  /** This show's share of the latest week's total reported gross, in percent. */
  marketSharePct: number | null;
  /** Attendance in the week before the latest one (for WoW delta). */
  attendancePrevWeek: number | null;
  /** Attendance ~52 weeks before the latest week (for YoY delta). */
  attendanceYoY: number | null;
  /** Count of weeks this show has reported grosses (weeks on the boards). */
  weeksOnBoards: number | null;
}

const SPARKLINE_WEEKS = 12;
const MIN_SPARKLINE_POINTS = 4;
const YOY_TOLERANCE_DAYS = 14;

function weekAtOffsetDays(latest: string, days: number): string | null {
  const target = new Date(latest + 'T00:00:00Z').getTime() - days * 86_400_000;
  let best: string | null = null;
  let bestDelta = Infinity;
  for (const wk of sortedWeeks) {
    const delta = Math.abs(new Date(wk + 'T00:00:00Z').getTime() - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = wk;
    }
  }
  return best !== null && bestDelta <= YOY_TOLERANCE_DAYS * 86_400_000 ? best : null;
}

/**
 * Derive sparkline, rank, market share, attendance deltas, and run length for
 * one show from the full grosses history. Returns null when the show has no
 * history at all (the card then renders without the history-driven elements).
 */
export function getBoxOfficeHistoryStats(slug: string): BoxOfficeHistoryStats | null {
  if (sortedWeeks.length === 0) return null;

  let weeksOnBoards = 0;
  for (const wk of sortedWeeks) {
    if (history.weeks[wk]?.[slug]?.gross != null) weeksOnBoards++;
  }
  if (weeksOnBoards === 0) return null;

  const latestWeek = sortedWeeks[sortedWeeks.length - 1];
  const latestShows = history.weeks[latestWeek] || {};

  // Rank + market share from the latest week's reporting shows.
  let rank: number | null = null;
  let rankedShows: number | null = null;
  let marketSharePct: number | null = null;
  const thisWeekGross = latestShows[slug]?.gross ?? null;
  if (thisWeekGross != null) {
    const grosses = Object.values(latestShows)
      .map((s) => s.gross)
      .filter((g): g is number => g != null)
      .sort((a, b) => b - a);
    rankedShows = grosses.length;
    rank = grosses.findIndex((g) => g <= thisWeekGross) + 1;
    const total = grosses.reduce((sum, g) => sum + g, 0);
    if (total > 0) marketSharePct = (thisWeekGross / total) * 100;
  }

  // Trailing sparkline: last 12 calendar weeks, keeping only weeks with data.
  const sparkline: SparklinePoint[] = [];
  for (const wk of sortedWeeks.slice(-SPARKLINE_WEEKS)) {
    const gross = history.weeks[wk]?.[slug]?.gross;
    if (gross != null) sparkline.push({ weekEnding: wk, gross });
  }

  // Attendance deltas: previous week (WoW) and ~1 year back (YoY).
  const prevWeek = sortedWeeks[sortedWeeks.length - 2];
  const attendancePrevWeek = prevWeek ? history.weeks[prevWeek]?.[slug]?.attendance ?? null : null;
  const yoyWeek = weekAtOffsetDays(latestWeek, 364);
  const attendanceYoY = yoyWeek ? history.weeks[yoyWeek]?.[slug]?.attendance ?? null : null;

  return {
    sparkline: sparkline.length >= MIN_SPARKLINE_POINTS ? sparkline : [],
    rank,
    rankedShows,
    marketSharePct,
    attendancePrevWeek,
    attendanceYoY,
    weeksOnBoards,
  };
}
