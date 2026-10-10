// Commercial / Biz Dashboard data module
// Imports: commercial.json (~88 KB), grosses-history.json (~234 KB), shows.json (~1.3 MB)
// Also imports getShowGrosses from data-grosses (~112 KB)
// Does NOT import reviews.json — uses raw show metadata instead of computed scores
//
// Pure rules (weeks to recoup, trends, capital totals, at-risk/approaching
// gates) live in ./commercial-metrics and ./commercial-display so they are
// unit-tested with fixtures; this module only feeds them data.

import type { RawShow } from './engine';
import type {
  ShowCommercial,
  SeasonStats,
  ApproachingRecoupmentShow,
  AtRiskShow,
  RecentRecoupmentShow,
  RecentClosing,
  UpcomingClosing,
  CommercialShowRow,
} from './data-types';
import type { CommercialDesignation, RecoupmentTrend } from '@/config/commercial';
import { getDesignationSortOrder } from '@/config/commercial';
import { getShowGrosses } from './data-grosses';
import {
  calculateWeeksToRecoup,
  computeGrossTrend,
  trailingAverageGross,
  summarizeCapital,
  isExcludedFromSeasonStats,
  isRunningStatus,
  isAtRisk,
  isApproachingRecoupment,
  DISPLAY_TREND_THRESHOLD_PCT,
} from './commercial-metrics';
import {
  getDisplayableModelRange,
  getBreakEven,
  getReportedInvestorMultiple,
  publicSourceText,
  isEstimatedCapitalization,
  isUnannouncedRecoupment,
  isEstimatedRunningCost,
  getNonprofitProducer,
} from './commercial-display';
import commercialData from '../../data/commercial.json';
import grossesHistoryData from '../../data/grosses-history.json';
import showsData from '../../data/shows.json';

// Re-exported so existing imports from data-commercial / data.ts keep working.
export { calculateWeeksToRecoup };

// Internal types
interface CommercialFile {
  _meta: {
    description: string;
    lastUpdated: string;
    sources: string;
    designations: Record<string, string>;
  };
  /** Date the recoupment model last ran (merge-model-recoupment.js). */
  modelLastRun?: string;
  shows: Record<string, ShowCommercial>;
}

interface GrossesHistoryWeek {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  performances: number | null;
}

interface GrossesHistoryFile {
  _meta: {
    description: string;
    lastUpdated: string;
  };
  weeks: Record<string, Record<string, GrossesHistoryWeek>>;
}

const commercial = commercialData as unknown as CommercialFile;
const grossesHistory = grossesHistoryData as unknown as GrossesHistoryFile;
const rawShows = showsData.shows as RawShow[];

/** Every reported week across Broadway, newest first. */
const WEEK_KEYS_NEWEST_FIRST = Object.keys(grossesHistory.weeks).sort().reverse();

// ============================================
// Pure utility functions
// ============================================

/**
 * Get Broadway season for a given date
 * Broadway seasons run July 1 - June 30
 * Returns format: "2024-2025"
 */
export function getSeason(dateString: string | null | undefined): string | null {
  if (!dateString) return null;

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = date.getMonth();

  if (month >= 6) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// ============================================
// Basic commercial data queries
// ============================================

/**
 * Get commercial data for a specific show by slug
 */
export function getShowCommercial(slug: string): ShowCommercial | undefined {
  return commercial.shows[slug];
}

/**
 * Get commercial designation for a show by slug
 */
export function getCommercialDesignation(slug: string): CommercialDesignation | undefined {
  return commercial.shows[slug]?.designation;
}

/**
 * Check if a show has recouped its investment (by slug)
 */
export function hasRecouped(slug: string): boolean | null {
  return commercial.shows[slug]?.recouped ?? null;
}

/**
 * Get capitalization for a show by slug
 */
export function getCapitalization(slug: string): number | null {
  return commercial.shows[slug]?.capitalization ?? null;
}

/**
 * Get show slugs by commercial designation
 */
export function getShowsByDesignation(designation: CommercialDesignation): string[] {
  const results: string[] = [];
  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation === designation) {
      results.push(slug);
    }
  }
  return results;
}

/**
 * Get all shows that have recouped (returns slugs)
 */
export function getRecoupedShows(): Array<{ slug: string; capitalization: number | null; recoupedDate: string | null }> {
  const results: Array<{ slug: string; capitalization: number | null; recoupedDate: string | null }> = [];
  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.recouped === true) {
      results.push({
        slug,
        capitalization: data.capitalization,
        recoupedDate: data.recoupedDate,
      });
    }
  }
  return results.sort((a, b) => {
    if (!a.recoupedDate) return 1;
    if (!b.recoupedDate) return -1;
    return new Date(b.recoupedDate).getTime() - new Date(a.recoupedDate).getTime();
  });
}

/**
 * Get all show slugs that have commercial data
 */
export function getAllCommercialSlugs(): string[] {
  return Object.keys(commercial.shows);
}

/**
 * Get commercial data last updated timestamp
 */
export function getCommercialLastUpdated(): string {
  return commercial._meta.lastUpdated;
}

/**
 * Date the recoupment model last ran, or null when the file does not say.
 */
export function getCommercialModelLastRun(): string | null {
  return commercial.modelLastRun ?? null;
}

/**
 * Get commercial designation description
 */
export function getDesignationDescription(designation: CommercialDesignation): string {
  return commercial._meta.designations[designation] || '';
}

// ============================================
// Biz Dashboard / Investment Tracker
// ============================================

/**
 * Weekly grosses for a show over the most recent `weeks` Broadway weeks,
 * newest first. A week the show did not report is null, so a closed show's
 * recent window is all null.
 */
export function getRecentGrosses(slug: string, weeks: number = 8): Array<number | null> {
  return WEEK_KEYS_NEWEST_FIRST.slice(0, weeks).map(
    (key) => grossesHistory.weeks[key]?.[slug]?.gross ?? null
  );
}

/**
 * Get all seasons that have commercial data, sorted by most recent first
 * Automatically discovers seasons from the data - no hardcoding needed
 */
export function getSeasonsWithCommercialData(): string[] {
  const seasonsSet = new Set<string>();

  for (const slug of Object.keys(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const season = getSeason(show.openingDate);
    if (season) {
      seasonsSet.add(season);
    }
  }

  return Array.from(seasonsSet).sort((a, b) => b.localeCompare(a));
}

/**
 * Get season statistics: capital at risk, recoupment count, etc.
 *
 * Capital at risk (BRO-4623 P0-6) = every running (open/previews) commercial
 * show that has not recouped, whatever its designation, with unknown
 * capitalizations counted as undisclosed rather than $0. It used to sum only
 * TBD + open + known-cap shows, so a season of running shows read "~$0".
 */
export function getSeasonStats(season: string): SeasonStats {
  const recoupedShowsList: string[] = [];
  const atRiskCaps: Array<number | null> = [];
  const allCaps: Array<number | null> = [];
  let recoupedCount = 0;
  let totalShows = 0;

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    // Pure nonprofits and tour stops are left out; enhancement deals stay in
    // (isExcludedFromSeasonStats, tested in tests/unit/season-stats-enhancement-filter.test.mjs).
    if (isExcludedFromSeasonStats(data)) continue;

    totalShows++;
    allCaps.push(data.capitalization);

    if (data.recouped === true) {
      recoupedCount++;
      recoupedShowsList.push(show.title);
    } else if (isRunningStatus(show.status)) {
      atRiskCaps.push(data.capitalization);
    }
  }

  return {
    season,
    capitalAtRisk: summarizeCapital(atRiskCaps),
    totalCapital: summarizeCapital(allCaps),
    recoupedCount,
    totalShows,
    recoupedShows: recoupedShowsList,
  };
}

/**
 * Box office trend for a show: trailing 4-week mean gross vs the prior
 * 4-week mean (computeGrossTrend). It used to average the last three
 * week-over-week changes, which a single holiday week could swing.
 *
 * `threshold` is the % change in the 4-week mean that counts as a trend
 * rather than 'steady'. The default is tuned for the display badge; callers
 * that need to tell a genuine slide from ordinary seasonal softness (the
 * approaching-recoupment gate) pass a larger one instead of duplicating this.
 * Closed shows get 'unknown' (no recent weeks).
 */
export function getRecoupmentTrend(slug: string, threshold: number = DISPLAY_TREND_THRESHOLD_PCT): RecoupmentTrend {
  return computeGrossTrend(getRecentGrosses(slug, 8), threshold);
}

// ============================================
// Grosses trend functions
// ============================================

export interface ShowGrossTrend {
  wow: number | null;
  yoy: number | null;
  avgCapacity4wk: number | null;
}

export interface SeasonGrossTrend {
  totalWoW: number;
  avgCapacity: number;
  showCount: number;
}

/**
 * Get gross trend data for a single show: WoW change, YoY change, and 4-week avg capacity.
 * Reuses the same grossesHistory data and week-key sorting as getRecoupmentTrend.
 */
export function getShowGrossTrend(slug: string): ShowGrossTrend {
  const weekKeys = Object.keys(grossesHistory.weeks).sort();
  const result: ShowGrossTrend = { wow: null, yoy: null, avgCapacity4wk: null };

  if (weekKeys.length < 2) return result;

  // WoW: compare last two weeks with valid gross data for this show
  const latestWeek = grossesHistory.weeks[weekKeys[weekKeys.length - 1]]?.[slug];
  const prevWeek = grossesHistory.weeks[weekKeys[weekKeys.length - 2]]?.[slug];

  if (latestWeek?.gross != null && prevWeek?.gross != null && prevWeek.gross > 0) {
    result.wow = ((latestWeek.gross - prevWeek.gross) / prevWeek.gross) * 100;
  }

  // YoY: compare latest week to same week ~52 weeks ago
  if (weekKeys.length >= 52) {
    const yoyWeek = grossesHistory.weeks[weekKeys[weekKeys.length - 52]]?.[slug];
    if (latestWeek?.gross != null && yoyWeek?.gross != null && yoyWeek.gross > 0) {
      result.yoy = ((latestWeek.gross - yoyWeek.gross) / yoyWeek.gross) * 100;
    }
  }

  // avgCapacity4wk: average capacity over last 4 weeks
  const recentWeeks = weekKeys.slice(-4);
  const capacities: number[] = [];
  for (const wk of recentWeeks) {
    const entry = grossesHistory.weeks[wk]?.[slug];
    if (entry?.capacity != null) {
      capacities.push(entry.capacity);
    }
  }
  if (capacities.length > 0) {
    result.avgCapacity4wk = capacities.reduce((a, b) => a + b, 0) / capacities.length;
  }

  return result;
}

/**
 * Get aggregate gross trend across all currently-running shows.
 * Returns total WoW gross change (%), average capacity, and count of shows included.
 */
export function getSeasonGrossTrend(): SeasonGrossTrend {
  const weekKeys = Object.keys(grossesHistory.weeks).sort();
  const fallback: SeasonGrossTrend = { totalWoW: 0, avgCapacity: 0, showCount: 0 };

  if (weekKeys.length < 2) return fallback;

  const latestWeekKey = weekKeys[weekKeys.length - 1];
  const prevWeekKey = weekKeys[weekKeys.length - 2];
  const latestData = grossesHistory.weeks[latestWeekKey] || {};
  const prevData = grossesHistory.weeks[prevWeekKey] || {};

  let totalLatest = 0;
  let totalPrev = 0;
  const capacities: number[] = [];
  const showSlugs = new Set<string>();

  for (const [slug, entry] of Object.entries(latestData)) {
    if (entry.gross == null) continue;
    const prev = prevData[slug];
    if (prev?.gross == null) continue;

    totalLatest += entry.gross;
    totalPrev += prev.gross;
    showSlugs.add(slug);

    if (entry.capacity != null) {
      capacities.push(entry.capacity);
    }
  }

  const showCount = showSlugs.size;
  const totalWoW = totalPrev > 0 ? ((totalLatest - totalPrev) / totalPrev) * 100 : 0;
  const avgCapacity = capacities.length > 0
    ? capacities.reduce((a, b) => a + b, 0) / capacities.length
    : 0;

  return { totalWoW, avgCapacity, showCount };
}

// Gate threshold (%) for excluding a show from "Approaching Recoupment" on
// trend alone: the 4-week mean gross down more than this vs the prior 4
// weeks. Deliberately coarser than the display badge's threshold: at the
// badge's setting, ordinary seasonal softness (summer, post-Tony) flags
// 'declining' on nearly every open show at once, which silently zeroed out
// this whole section. 15% on 4-week means is roughly the old 8%-average-WoW
// setting over the same span: an actual slide, not a slow week.
export const APPROACHING_RECOUPMENT_SHARP_DECLINE_THRESHOLD_PCT = 15;

/**
 * Shows approaching recoupment (BRO-4623 P1-2): open, TBD, not recouped,
 * with a model range that clears the display quality floor AND whose
 * pessimistic case is at least 50% (isApproachingRecoupment), and no sharp
 * gross decline. Legacy AI estimates (estimatedRecoupmentPct) are never used:
 * the card would contradict the table, which hides them.
 */
export function getShowsApproachingRecoupment(): ApproachingRecoupmentShow[] {
  const results: ApproachingRecoupmentShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation !== 'TBD' || data.recouped === true) continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const range = getDisplayableModelRange({ ...data, status: show.status });
    if (!range || !isApproachingRecoupment(range)) continue;

    const isSharpDecline =
      getRecoupmentTrend(slug, APPROACHING_RECOUPMENT_SHARP_DECLINE_THRESHOLD_PCT) === 'declining';
    if (isSharpDecline) continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization ?? null,
      capitalizationIsEstimate: isEstimatedCapitalization(data),
      modelRecoupmentPct: range,
      modelMethod: data.modelMethod || null,
      trend: getRecoupmentTrend(slug),
      weeklyGross: grossData?.thisWeek?.gross || null,
    });
  }

  // Highest central estimate first
  return results.sort((a, b) => b.modelRecoupmentPct[1] - a.modelRecoupmentPct[1]);
}

/**
 * Shows truly at risk (BRO-4623 P0-7, P1-3): running, unrecouped, trailing
 * 4-week average gross below break-even (getBreakEven, the same figure the
 * show page uses), AND under 30% recouped even in the model's optimistic
 * case. A show with no displayable estimate is skipped, never defaulted to 0%.
 */
export function getShowsAtRisk(): AtRiskShow[] {
  const results: AtRiskShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation !== 'TBD') continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const range = getDisplayableModelRange({ ...data, status: show.status });
    const avgGross = trailingAverageGross(getRecentGrosses(slug, 4));
    const breakEven = getBreakEven(data);

    if (!isAtRisk({ status: show.status, recouped: data.recouped, recoupmentRange: range, avgGross, breakEven })) {
      continue;
    }

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization ?? null,
      capitalizationIsEstimate: isEstimatedCapitalization(data),
      avgWeeklyGross: avgGross as number,
      breakEven: breakEven as number,
      modelRecoupmentPct: range as [number, number, number],
      trend: getRecoupmentTrend(slug),
    });
  }

  return results.sort((a, b) => {
    const deficitA = a.breakEven - a.avgWeeklyGross;
    const deficitB = b.breakEven - b.avgWeeklyGross;
    return deficitB - deficitA;
  });
}

/**
 * Get shows that recouped within the specified number of months.
 * weeksToRecoup is null when only the recoupment year is known (or the date
 * is inconsistent with the run); those rows stay listed with a blank week count.
 * A recoupment that was never announced is not news and has no reliable date,
 * so it is left out (isUnannouncedRecoupment).
 */
export function getRecentRecoupments(months: number = 24): RecentRecoupmentShow[] {
  const results: RecentRecoupmentShow[] = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (!data.recouped || !data.recoupedDate) continue;
    if (isUnannouncedRecoupment(data)) continue;

    const recoupDate = new Date(data.recoupedDate + '-01');
    if (isNaN(recoupDate.getTime()) || recoupDate < cutoffDate) continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      weeksToRecoup: calculateWeeksToRecoup(show.openingDate, data.recoupedDate, show.closingDate),
      capitalization: data.capitalization ?? null,
      capitalizationIsEstimate: isEstimatedCapitalization(data),
      recoupDate: data.recoupedDate,
    });
  }

  return results.sort((a, b) => {
    return new Date(b.recoupDate).getTime() - new Date(a.recoupDate).getTime();
  });
}

/**
 * Get shows that recently closed without recouping (flops/fizzles)
 */
export function getRecentClosings(months: number = 6): RecentClosing[] {
  const results: RecentClosing[] = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  for (const show of rawShows) {
    if (show.status !== 'closed' || !show.closingDate) continue;

    const closingDate = new Date(show.closingDate);
    if (isNaN(closingDate.getTime()) || closingDate < cutoffDate) continue;
    if (closingDate > new Date()) continue;

    const data = commercial.shows[show.slug];
    if (!data) continue;

    if (data.recouped === true) continue;

    const wasFlop = data.designation === 'Flop' || data.designation === 'Fizzle';

    results.push({
      slug: show.slug,
      title: show.title,
      closingDate: show.closingDate,
      designation: data.designation,
      wasFlop,
    });
  }

  return results.sort((a, b) => {
    return new Date(b.closingDate).getTime() - new Date(a.closingDate).getTime();
  });
}

/**
 * Get shows with announced upcoming closing dates
 */
export function getUpcomingClosings(): UpcomingClosing[] {
  const results: UpcomingClosing[] = [];
  const now = new Date();
  const twoMonthsOut = new Date();
  twoMonthsOut.setMonth(twoMonthsOut.getMonth() + 2);

  for (const show of rawShows) {
    if (show.status !== 'open' || !show.closingDate) continue;

    const closingDate = new Date(show.closingDate);
    if (isNaN(closingDate.getTime())) continue;
    if (closingDate <= now || closingDate > twoMonthsOut) continue;

    const data = commercial.shows[show.slug];
    if (!data) continue;

    results.push({
      slug: show.slug,
      title: show.title,
      closingDate: show.closingDate,
      designation: data.designation,
    });
  }

  return results.sort((a, b) => {
    return new Date(a.closingDate).getTime() - new Date(b.closingDate).getTime();
  });
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * One /biz table row. Closed shows get no weekly gross and no trend (their
 * recent weeks are empty); only a reported, cited investor multiple is passed
 * (getReportedInvestorMultiple), never a modeled one.
 */
function toCommercialShowRow(slug: string, show: RawShow, data: ShowCommercial): CommercialShowRow {
  const grossData = getShowGrosses(slug);
  const running = isRunningStatus(show.status);
  return {
    slug,
    title: show.title,
    status: show.status,
    designation: data.designation,
    capitalization: data.capitalization,
    capitalizationIsEstimate: isEstimatedCapitalization(data),
    weeklyGross: running ? grossData?.thisWeek?.gross || null : null,
    // A zero or non-numeric figure is a scrape gap (dark week, partial row), not a real 0% / $0.
    weeklyCapacity: running ? positiveOrNull(grossData?.thisWeek?.capacity) : null,
    weeklyAtp: running ? positiveOrNull(grossData?.thisWeek?.atp) : null,
    weeklyCost: data.weeklyRunningCost || null,
    weeklyCostIsEstimate: isEstimatedRunningCost(data),
    nonprofitOrg: getNonprofitProducer(data),
    totalGross: grossData?.allTime?.gross || null,
    modelRecoupmentPct: data.modelRecoupmentPct || null,
    modelMethod: data.modelMethod || null,
    modelDataQuality: data.modelDataQuality,
    reportedMultiple: getReportedInvestorMultiple(data),
    // AllShowsTable is a client component: the row lands in the page payload, so only publishable text.
    recoupedSource: publicSourceText(data.recoupedSource),
    trend: running ? getRecoupmentTrend(slug) : 'unknown',
    recouped: data.recouped,
    recoupmentNotAnnounced: isUnannouncedRecoupment(data),
    recoupedWeeks: calculateWeeksToRecoup(show.openingDate, data.recoupedDate, show.closingDate),
  };
}

/**
 * Get all open shows with commercial data for the full table
 */
export function getAllOpenShowsWithCommercial(): CommercialShowRow[] {
  const results: CommercialShowRow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;
    results.push(toCommercialShowRow(slug, show, data));
  }

  return results;
}

/**
 * Get all shows from a specific season with commercial data
 * Includes both open and closed shows
 */
export function getShowsBySeasonWithCommercial(season: string): CommercialShowRow[] {
  const results: CommercialShowRow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    results.push(toCommercialShowRow(slug, show, data));
  }

  return results.sort((a, b) => {
    const orderDiff = getDesignationSortOrder(a.designation) - getDesignationSortOrder(b.designation);
    if (orderDiff !== 0) return orderDiff;
    return a.title.localeCompare(b.title);
  });
}
