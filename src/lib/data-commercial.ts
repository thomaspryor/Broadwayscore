// Commercial / Biz Dashboard data module
// Imports: commercial.json (~88 KB), grosses-history.json (~234 KB), shows.json (~1.3 MB)
// Also imports getShowGrosses from data-grosses (~112 KB)
// Does NOT import reviews.json — uses raw show metadata instead of computed scores

import type { RawShow } from './engine';
import type {
  ShowCommercial,
  SeasonStats,
  ApproachingRecoupmentShow,
  AtRiskShow,
  RecentRecoupmentShow,
  RecentClosing,
  UpcomingClosing,
} from './data-types';
import type { CommercialDesignation, RecoupmentTrend } from '@/config/commercial';
import { getDesignationSortOrder } from '@/config/commercial';
import { getShowGrosses } from './data-grosses';
import commercialData from '../../data/commercial.json';
import grossesHistoryData from '../../data/grosses-history.json';
import showsData from '../../data/shows.json';

// Internal types
interface CommercialFile {
  _meta: {
    description: string;
    lastUpdated: string;
    sources: string;
    designations: Record<string, string>;
  };
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

// ============================================
// Pure utility functions
// ============================================

/**
 * Calculate weeks to recoup from opening date and recoup date
 * This is the source of truth - never use manually stored recoupedWeeks
 */
export function calculateWeeksToRecoup(openingDate: string | null, recoupedDate: string | null): number | null {
  if (!openingDate || !recoupedDate) return null;

  try {
    const openDate = new Date(openingDate);
    if (isNaN(openDate.getTime())) return null;

    let recoupDate: Date;
    if (/^\d{4}-\d{2}$/.test(recoupedDate)) {
      const [year, month] = recoupedDate.split('-');
      recoupDate = new Date(parseInt(year), parseInt(month), 0);
    } else if (/^\d{4}$/.test(recoupedDate)) {
      recoupDate = new Date(parseInt(recoupedDate), 11, 31);
    } else {
      return null;
    }

    if (isNaN(recoupDate.getTime())) return null;

    const diffMs = recoupDate.getTime() - openDate.getTime();
    if (diffMs < 0) return null;

    return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  } catch {
    return null;
  }
}

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
 * Get commercial designation description
 */
export function getDesignationDescription(designation: CommercialDesignation): string {
  return commercial._meta.designations[designation] || '';
}

// ============================================
// Biz Dashboard / Investment Tracker
// ============================================

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
 */
export function getSeasonStats(season: string): SeasonStats {
  const recoupedShowsList: string[] = [];
  let capitalAtRisk = 0;
  let recoupedCount = 0;
  let totalShows = 0;

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    if (data.designation === 'Nonprofit' || data.designation === 'Tour Stop') continue;

    totalShows++;

    if (data.recouped === true) {
      recoupedCount++;
      recoupedShowsList.push(show.title);
    } else if (
      data.designation === 'TBD' &&
      show.status === 'open' &&
      data.capitalization
    ) {
      capitalAtRisk += data.capitalization;
    }
  }

  return {
    season,
    capitalAtRisk,
    recoupedCount,
    totalShows,
    recoupedShows: recoupedShowsList,
  };
}

/**
 * Get recoupment trend for a show based on recent grosses history
 * Uses last 4 weeks of data, calculates average WoW change
 */
export function getRecoupmentTrend(slug: string): RecoupmentTrend {
  const weekKeys = Object.keys(grossesHistory.weeks).sort().reverse();

  if (weekKeys.length < 3) return 'unknown';

  const grosses: number[] = [];
  for (let i = 0; i < Math.min(4, weekKeys.length); i++) {
    const weekData = grossesHistory.weeks[weekKeys[i]]?.[slug];
    if (weekData?.gross) {
      grosses.push(weekData.gross);
    }
  }

  if (grosses.length < 3) return 'unknown';

  const wowChanges: number[] = [];
  for (let i = 0; i < grosses.length - 1; i++) {
    const current = grosses[i];
    const previous = grosses[i + 1];
    if (previous > 0) {
      const change = ((current - previous) / previous) * 100;
      wowChanges.push(change);
    }
  }

  if (wowChanges.length === 0) return 'unknown';

  const avgChange = wowChanges.reduce((a, b) => a + b, 0) / wowChanges.length;

  if (avgChange > 2) return 'improving';
  if (avgChange < -2) return 'declining';
  return 'steady';
}

/**
 * Get shows approaching recoupment (TBD with 40%+ recoupment estimate, not declining)
 */
export function getShowsApproachingRecoupment(): ApproachingRecoupmentShow[] {
  const results: ApproachingRecoupmentShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation !== 'TBD') continue;
    if (!data.estimatedRecoupmentPct) continue;

    const [lower] = data.estimatedRecoupmentPct;
    if (lower < 40) continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const trend = getRecoupmentTrend(slug);
    if (trend === 'declining') continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization || 0,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct,
      trend,
      weeklyGross: grossData?.thisWeek?.gross || null,
    });
  }

  return results.sort((a, b) => b.estimatedRecoupmentPct[1] - a.estimatedRecoupmentPct[1]);
}

/**
 * Get shows truly at risk (below break-even AND below 30% recouped)
 */
export function getShowsAtRisk(): AtRiskShow[] {
  const results: AtRiskShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation !== 'TBD') continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const trend = getRecoupmentTrend(slug);
    const grossData = getShowGrosses(slug);
    const weeklyGross = grossData?.thisWeek?.gross;
    const weeklyRunningCost = data.weeklyRunningCost;

    if (!weeklyGross || !weeklyRunningCost) continue;

    const isBelowBreakEven = weeklyGross < weeklyRunningCost;
    const estRecoupmentHigh = data.estimatedRecoupmentPct?.[1] || 0;
    const isBelowRecoupmentThreshold = estRecoupmentHigh < 30;

    if (!isBelowBreakEven || !isBelowRecoupmentThreshold) continue;

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization || 0,
      weeklyGross,
      weeklyRunningCost,
      trend,
    });
  }

  return results.sort((a, b) => {
    const deficitA = a.weeklyRunningCost - a.weeklyGross;
    const deficitB = b.weeklyRunningCost - b.weeklyGross;
    return deficitB - deficitA;
  });
}

/**
 * Get shows that recouped within the specified number of months
 */
export function getRecentRecoupments(months: number = 24): RecentRecoupmentShow[] {
  const results: RecentRecoupmentShow[] = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (!data.recouped || !data.recoupedDate) continue;

    const recoupDate = new Date(data.recoupedDate + '-01');
    if (isNaN(recoupDate.getTime()) || recoupDate < cutoffDate) continue;

    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const weeksToRecoup = calculateWeeksToRecoup(show.openingDate, data.recoupedDate);
    if (weeksToRecoup === null) continue;

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      weeksToRecoup,
      capitalization: data.capitalization || 0,
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

/**
 * Get all open shows with commercial data for the full table
 */
export function getAllOpenShowsWithCommercial(): Array<{
  slug: string;
  title: string;
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}> {
  const results: Array<{
    slug: string;
    title: string;
    designation: CommercialDesignation;
    capitalization: number | null;
    weeklyGross: number | null;
    totalGross: number | null;
    estimatedRecoupmentPct: [number, number] | null;
    trend: RecoupmentTrend;
    recouped: boolean | null;
    recoupedWeeks: number | null;
  }> = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      designation: data.designation,
      capitalization: data.capitalization,
      weeklyGross: grossData?.thisWeek?.gross || null,
      totalGross: grossData?.allTime?.gross || null,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct || null,
      trend: getRecoupmentTrend(slug),
      recouped: data.recouped,
      recoupedWeeks: calculateWeeksToRecoup(show.openingDate, data.recoupedDate),
    });
  }

  return results;
}

/**
 * Get all shows from a specific season with commercial data
 * Includes both open and closed shows
 */
export function getShowsBySeasonWithCommercial(season: string): Array<{
  slug: string;
  title: string;
  status: 'open' | 'closed' | 'previews';
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}> {
  const results: Array<{
    slug: string;
    title: string;
    status: 'open' | 'closed' | 'previews';
    designation: CommercialDesignation;
    capitalization: number | null;
    weeklyGross: number | null;
    totalGross: number | null;
    estimatedRecoupmentPct: [number, number] | null;
    trend: RecoupmentTrend;
    recouped: boolean | null;
    recoupedWeeks: number | null;
  }> = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      status: show.status as 'open' | 'closed' | 'previews',
      designation: data.designation,
      capitalization: data.capitalization,
      weeklyGross: grossData?.thisWeek?.gross || null,
      totalGross: grossData?.allTime?.gross || null,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct || null,
      trend: getRecoupmentTrend(slug),
      recouped: data.recouped,
      recoupedWeeks: calculateWeeksToRecoup(show.openingDate, data.recoupedDate),
    });
  }

  return results.sort((a, b) => {
    const orderDiff = getDesignationSortOrder(a.designation) - getDesignationSortOrder(b.designation);
    if (orderDiff !== 0) return orderDiff;
    return a.title.localeCompare(b.title);
  });
}
