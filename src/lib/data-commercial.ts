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
import { getDesignationSortOrder, DESIGNATION_MAP, RECOUPED_DURING_RUN_ESTIMATE } from '@/config/commercial';
import { getShowGrosses, getGrossesWeekEnding } from './data-grosses';
import {
  calculateWeeksToRecoup,
  recoupReportedAfterClosing,
  resolveRecoupWeeks,
  computeGrossTrend,
  trailingAverageGross,
  summarizeCapital,
  isExcludedFromSeasonStats,
  isRunningStatus,
  isAtRisk,
  isApproachingRecoupment,
  DISPLAY_TREND_THRESHOLD_PCT,
  getSeason,
} from './commercial-metrics';
import {
  applyModelDisplayGuard,
  getAtRiskModelRange,
  getModelHoldLabel,
  getDisplayableModelRange,
  getBreakEven,
  getReportedInvestorMultiple,
  getEstimatedReturnRange,
  publicSourceText,
  lossBasisCaveat,
  likelyOutcomeLine,
  likelyOutcomeBasis,
  isEstimatedCapitalization,
  isMaximumCapitalization,
  isUnannouncedRecoupment,
  isEstimatedRunningCost,
  getNonprofitProducer,
  getCitedSourceUrl,
  meetsModelQualityFloor,
  hasNoInvestorsToRepay,
  publicHeldRange,
} from './commercial-display';
import { continuationIds } from '../../scripts/lib/cap-comparables';
import { reportedReturn } from '../../scripts/lib/reported-return';
import type { TopicShowInput } from './investment-topics';
import { buildSeasonProfiles, buildRecoupFindings, compareSeason, hasKnownOutcome, isOwnEstimate, trackedRecord, type SeasonProfile, type SeasonComparison, type RecoupFindings } from './season-profile';
import fs from 'fs';
import path from 'path';
import { getMarketDate } from './date-utils';
import { isLossDesignation } from '../../scripts/lib/commercial-designations';
import { conversionOf, isConvertedToCommercial, commercialRunWeeks, recoupClockStart } from '../../scripts/lib/commercial-conversion';
import {
  computeMarketMedianByWeek,
  computeShowStatus,
  countStatuses,
  makeStaticCostProvider,
  reconcileWithAtRisk,
  staleInputReasons,
  v2CostBasis,
  type CostProvider,
  type V2CostBasis,
  type ShowBoxOfficeStatus,
  type WeekRow,
} from './box-office-status';
import commercialData from '../../data/commercial.json';
import showOriginsData from '../../data/show-origins.json';
import { buildOriginFindings, type OriginFindings, type OriginRecord } from './show-origins';
import grossesHistoryData from '../../data/grosses-history.json';
import showsData from '../../data/shows.json';
import { partitionShowRows } from '../../scripts/lib/show-row-guard';
import { showFacts, type MarketInput, type MarketShow, type ShowFacts } from './box-office-market';
import type { HistoryWeeks } from './box-office-weeks';
import { buildMarketPage, type MarketPage } from './box-office-display';
import { costStatusCell, statusCounts, type StatusCounts } from './box-office-v2-display';

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
  seatsOffered?: number | null;
}

interface GrossesHistoryFile {
  _meta: {
    description: string;
    lastUpdated: string;
  };
  weeks: Record<string, Record<string, GrossesHistoryWeek>>;
}

const grossesHistory = grossesHistoryData as unknown as GrossesHistoryFile;
const rawShows = partitionShowRows(showsData.shows).valid as RawShow[];

// Every page reads the model bar through this one guarded copy (BRO-4989):
// hidden when too early, off its rails or when two independent estimates disagree, and
// never negative.
const commercial: CommercialFile = (() => {
  const file = commercialData as unknown as CommercialFile;
  const showBySlug = new Map(rawShows.map((s) => [s.slug, s]));
  const now = new Date();
  const shows: Record<string, ShowCommercial> = {};
  for (const [slug, full] of Object.entries(file.shows)) {
    // costHistory (BRO-5604: ~1,400 dated anchors) feeds only the offline
    // recoupment model; keep it out of page props and the client payload.
    const { costHistory: _costHistory, ...data } = full as ShowCommercial & { costHistory?: unknown };
    const guarded = applyModelDisplayGuard(data, showBySlug.get(slug), now);
    const rr = reportedReturn(data, showBySlug.get(slug));
    // From the unguarded record: the guard can hide the bar, and the best guess still stands (BRO-5647).
    // A reported return says what came back, so no guess beside it.
    const withStatus = { ...data, status: showBySlug.get(slug)?.status };
    const likelyOutcome = rr ? null : likelyOutcomeLine(withStatus);
    const likely = likelyOutcome ? { likelyOutcome, likelyOutcomeBasis: likelyOutcomeBasis(withStatus) ?? 'model' as const } : {};
    shows[slug] = { ...guarded, ...(rr ? { reportedReturn: rr } : {}), ...likely };
  }
  return { ...file, shows };
})();

/** Every reported week across Broadway, newest first. */
const WEEK_KEYS_NEWEST_FIRST = Object.keys(grossesHistory.weeks).sort().reverse();

// ============================================
// Pure utility functions
// ============================================

// getSeason lives in commercial-metrics (pure, no data imports) so the
// box-office status logic can use it; re-exported for existing callers.
export { getSeason };

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
  // The config is the one source of designation wording; commercial.json's
  // _meta.designations has no entry for Did Not Recoup (BRO-5636).
  return DESIGNATION_MAP[designation]?.description || '';
}

// ============================================
// Biz Dashboard / Profitability Scorecard
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

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show || !trackedRecord({ status: show.status, commercial: data })) continue;

    const season = getSeason(show.openingDate);
    if (season) {
      seasonsSet.add(season);
    }
  }

  return Array.from(seasonsSet).sort((a, b) => b.localeCompare(a));
}

// Season pages with fewer tracked shows than this still render (a show page
// links its season) but stay out of the sitemap and carry noindex: a
// one-show "season" page is thin and its season-level stats mislead (BRO-6192).
export const MIN_INDEXED_SEASON_SHOWS = 5;

export function isIndexedCommercialSeason(season: string): boolean {
  return getShowsBySeasonWithCommercial(season).length >= MIN_INDEXED_SEASON_SHOWS;
}

/**
 * Headline numbers for the /biz hero (BRO-6286), on the same population as
 * the season stats: commercial productions only (no pure nonprofits or tour
 * stops, no untracked placeholders), our own capitalization estimates and
 * Form D offering ceilings ("up to $X") left out of the disclosed sum, and
 * recoupments that carry recouped === true.
 */
/** Slugs of runs that continue an earlier production's capital (BRO-6360); their raise is counted once, with the earlier run. */
function continuationSlugs(): Set<string> {
  return continuationIds(rawShows.filter((s) => s.category === 'broadway' && commercial.shows[s.slug]).map((s) => ({
    id: s.slug, openingDate: s.openingDate, capitalization: commercial.shows[s.slug].capitalization, capitalizationSource: commercial.shows[s.slug].capitalizationSource,
  })));
}

export function getCommercialHeadlineStats(): { productions: number; disclosedCapitalization: number; disclosedCount: number; recouped: number } {
  let productions = 0;
  let disclosedCapitalization = 0;
  let disclosedCount = 0;
  let recouped = 0;
  const continuations = continuationSlugs();
  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;
    if (isExcludedFromSeasonStats(data) || !trackedRecord({ status: show.status, commercial: data })) continue;
    productions++;
    if (!continuations.has(slug) && typeof data.capitalization === 'number' && data.capitalization > 0 && !isOwnEstimate(data) && !isMaximumCapitalization(data)) {
      disclosedCapitalization += data.capitalization;
      disclosedCount++;
    }
    if (data.recouped === true) recouped++;
  }
  return { productions, disclosedCapitalization, disclosedCount, recouped };
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
  const continuations = continuationSlugs();

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find(s => s.slug === slug);
    if (!show) continue;

    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    // Pure nonprofits and tour stops are left out; enhancement deals stay in
    // (isExcludedFromSeasonStats, tested in tests/unit/season-stats-enhancement-filter.test.mjs).
    // A closed show with only a research placeholder is untracked and left out too (trackedRecord).
    if (isExcludedFromSeasonStats(data) || !trackedRecord({ status: show.status, commercial: data })) continue;

    // A continuation run is left out, as in getSeasonProfiles (its raise is counted with the earlier run).
    if (continuations.has(slug)) continue;
    // The recoup denominator: known outcomes only, as in buildSeasonProfiles (BRO-6354).
    if (hasKnownOutcome(show.status, data)) totalShows++;
    // Our own budget estimate counts as undisclosed here, as in getSeasonProfiles.
    const cap = isOwnEstimate(data) ? null : data.capitalization;
    allCaps.push(cap);

    if (data.recouped === true) {
      recoupedCount++;
      recoupedShowsList.push(show.title);
    } else if (isRunningStatus(show.status)) {
      atRiskCaps.push(cap);
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

/** Every Broadway season's profile (mix, capital, recoupment), newest first. Built once. */
let seasonProfilesCache: SeasonProfile[] | null = null;
/** A show in the Season Report's list: the same rows getSeasonProfiles counts. */
export interface SeasonListShow {
  slug: string;
  title: string;
  type: string;
  isRevival: boolean | null | undefined;
  openingDate: string | null;
}

/**
 * The season's Broadway shows exactly as getSeasonProfiles counts them (same
 * filter, raw isRevival), plus announced shows with no opening date yet, which
 * no season counts.
 */
export function getSeasonShowList(season: string): { dated: SeasonListShow[]; undated: SeasonListShow[] } {
  const pick = (s: RawShow): SeasonListShow => ({ slug: s.slug, title: s.title, type: s.type, isRevival: s.isRevival, openingDate: s.openingDate || null });
  const broadway = rawShows.filter((s) => s.category === 'broadway');
  return {
    dated: broadway
      .filter((s) => !!s.openingDate && getSeason(s.openingDate) === season)
      .map(pick)
      .sort((a, b) => a.openingDate!.localeCompare(b.openingDate!) || a.title.localeCompare(b.title)),
    undated: broadway
      .filter((s) => !s.openingDate && (s.status === 'announced' || s.status === 'upcoming'))
      .map(pick)
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export interface SeasonPaybackPoint {
  date: string;
  capital: number;
  returnedLow: number;
  returnedMid: number;
  returnedHigh: number;
  shows: number;
  of: number;
}

let paybackHistoryCache: Record<string, SeasonPaybackPoint[]> | null = null;

/**
 * One season's estimated payback over time (data/season-payback-history.json,
 * appended daily by commercial-stale-closures.yml, BRO-6335), oldest first.
 * Empty before the file exists (cloud sessions, first run).
 */
export function getSeasonPaybackHistory(season: string): SeasonPaybackPoint[] {
  if (!paybackHistoryCache) {
    paybackHistoryCache = {};
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'season-payback-history.json'), 'utf8'));
      for (const r of Array.isArray(rows) ? rows : []) (paybackHistoryCache[r.season] ??= []).push(r);
      for (const list of Object.values(paybackHistoryCache)) list.sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      /* no history file yet */
    }
  }
  return paybackHistoryCache[season] ?? [];
}

export function getSeasonProfiles(): SeasonProfile[] {
  if (!seasonProfilesCache) {
    const shows = commercial.shows;
    seasonProfilesCache = buildSeasonProfiles(
      rawShows
        .filter((s) => s.category === 'broadway' && !!s.openingDate)
        .map((s) => ({
          id: s.slug,
          type: s.type,
          isRevival: s.isRevival,
          openingDate: s.openingDate,
          status: s.status,
          commercial: shows[s.slug] ? { ...shows[s.slug], weeklyCost: shows[s.slug].weeklyRunningCost } : null,
        })),
    );
  }
  return seasonProfilesCache;
}

/**
 * Who recoups, by show type and critic score (public Season Report, BRO-5777).
 * Critic scores come from the caller (compositeScore by slug): this module
 * does not load reviews.
 */
export function getRecoupFindings(criticScoreBySlug: Map<string, number | null>, asOf: string = getMarketDate('broadway')): RecoupFindings {
  const shows = commercial.shows;
  return buildRecoupFindings(
    rawShows
      .filter((s) => s.category === 'broadway' && !!s.openingDate)
      .map((s) => ({
        type: s.type,
        isRevival: s.isRevival,
        openingDate: s.openingDate,
        status: s.status,
        criticScore: criticScoreBySlug.get(s.slug) ?? null,
        commercial: shows[s.slug] ?? null,
        slug: s.slug,
        title: s.title,
      })),
    asOf,
  );
}

/**
 * Broadway shows joined with their commercial.json record, for the topic pages
 * (investment-topics.ts). Scores come from the caller: canonical Critic Scores
 * and audience buzz by show id.
 */
export function getTopicShowInputs(
  criticScoreById: Map<string, number | null>,
  audienceScoreById: Map<string, number | null>,
): TopicShowInput[] {
  const shows = commercial.shows;
  return rawShows
    .filter((s) => s.category === 'broadway' && !!s.openingDate)
    .map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      type: s.type,
      isRevival: s.isRevival,
      tags: s.tags ?? null,
      openingDate: s.openingDate,
      closingDate: s.closingDate ?? null,
      status: s.status,
      criticScore: criticScoreById.get(s.id) ?? null,
      audienceScore: audienceScoreById.get(s.id) ?? null,
      commercial: shows[s.slug] ?? null,
    }));
}

/** Path to Broadway and source material findings (BRO-5842), as of today in New York (build time). */
export function getOriginFindings(asOf: string = getMarketDate('broadway')): OriginFindings {
  const shows = commercial.shows;
  return buildOriginFindings(
    rawShows
      .filter((s) => s.category === 'broadway' && !!s.openingDate && !(s as { cancelledBeforeOpening?: boolean }).cancelledBeforeOpening && !(s as { tourOf?: string }).tourOf)
      .map((s) => ({
        id: s.id,
        creativeTeam: (s as { creativeTeam?: Array<{ name?: string | null }> }).creativeTeam ?? null,
        closingDate: s.closingDate ?? null,
        type: s.type,
        isRevival: s.isRevival,
        openingDate: s.openingDate,
        status: s.status,
        criticScore: null,
        commercial: shows[s.slug] ?? null,
        slug: s.slug,
        title: s.title,
      })),
    (showOriginsData as unknown as { shows: Record<string, OriginRecord> }).shows,
    asOf,
  );
}

/** A season vs last season and the 10-season average, as of today in New York (build time). */
export function getSeasonComparison(season: string, asOf: string = getMarketDate('broadway')): SeasonComparison | null {
  return compareSeason(getSeasonProfiles(), season, asOf);
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
      capitalizationIsMaximum: isMaximumCapitalization(data),
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

    const range = getAtRiskModelRange({ ...data, status: show.status });
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
      capitalizationIsMaximum: isMaximumCapitalization(data),
      avgWeeklyGross: avgGross as number,
      breakEven: breakEven as number,
      modelRecoupmentPct: range as [number, number, number],
      modelHoldLabel: getModelHoldLabel({ ...data, status: show.status }),
      trend: getRecoupmentTrend(slug),
      closingDate: isFutureDate(show.closingDate) ? show.closingDate ?? null : null,
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
 * weeksToRecoup is null when only the recoupment year is known, or when the
 * recoupment was reported after its run closed (reportedAfterClosing); those
 * rows stay listed, the table says "Reported after closing" for the latter and
 * leaves the former blank.
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

    const weeks = recoupWeeks(slug, data, show);
    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      weeksToRecoup: weeks.weeks,
      weeksIsEstimate: weeks.isEstimate,
      weeksEstimateNote: weeks.isEstimate ? RECOUPED_DURING_RUN_ESTIMATE[slug] : null,
      fromCommercialRun: isConvertedToCommercial(data),
      reportedAfterClosing: recoupReportedAfterClosing(data.recoupedDate, show.closingDate),
      capitalization: data.capitalization ?? null,
      capitalizationIsEstimate: isEstimatedCapitalization(data),
      capitalizationIsMaximum: isMaximumCapitalization(data),
      recoupDate: data.recoupedDate,
      recoupDateIsEstimate: data.isEstimate?.recoupedDate === true,
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

    const wasFlop = isLossDesignation(data.designation);

    results.push({
      slug: show.slug,
      title: show.title,
      closingDate: show.closingDate,
      designation: data.designation,
      designationBasis: data.designationBasis ?? null,
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

/** True for an ISO day after today: a closing date that has passed on a still-open show is not "announced". */
function isFutureDate(date: string | null | undefined): boolean {
  return !!date && /^\d{4}-\d{2}-\d{2}/.test(date) && date.slice(0, 10) > new Date().toISOString().slice(0, 10);
}

/** Weeks to recoup for the /biz tables (resolveRecoupWeeks), with the owner's per-show estimate list applied. */
function recoupWeeks(
  slug: string,
  data: ShowCommercial,
  show: { openingDate?: string | null; closingDate?: string | null },
) {
  return resolveRecoupWeeks({
    startDate: recoupClockStart(data, show.openingDate),
    recoupedDate: data.recoupedDate,
    closingDate: show.closingDate,
    allowEstimate: Object.prototype.hasOwnProperty.call(RECOUPED_DURING_RUN_ESTIMATE, slug),
    dateIsEstimate: data.isEstimate?.recoupedDate === true,
  });
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * One /biz table row. Closed shows get no weekly gross and no trend (their
 * recent weeks are empty); only a reported, cited investor multiple is passed
 * (getReportedInvestorMultiple); a win label also gets our modeled range
 * (getEstimatedReturnRange), always labelled as an estimate.
 */
function toCommercialShowRow(slug: string, show: RawShow, data: ShowCommercial): CommercialShowRow {
  const grossData = getShowGrosses(slug);
  const running = isRunningStatus(show.status);
  const weeks = recoupWeeks(slug, data, show);
  return {
    slug,
    title: show.title,
    status: show.status,
    designation: data.designation,
    capitalization: data.capitalization,
    capitalizationIsEstimate: isEstimatedCapitalization(data),
    capitalizationIsMaximum: isMaximumCapitalization(data),
    weeklyGross: running ? grossData?.thisWeek?.gross || null : null,
    // A zero or non-numeric figure is a scrape gap (dark week, partial row), not a real 0% / $0.
    weeklyCapacity: running ? positiveOrNull(grossData?.thisWeek?.capacity) : null,
    weeklyAtp: running ? positiveOrNull(grossData?.thisWeek?.atp) : null,
    weeklyCost: data.weeklyRunningCost || null,
    weeklyCostIsEstimate: isEstimatedRunningCost(data),
    weeklyCostBasis: data.weeklyRunningCostBasis ?? null,
    nonprofitOrg: getNonprofitProducer(data),
    totalGross: grossData?.allTime?.gross || null,
    modelRecoupmentPct: data.modelRecoupmentPct || null,
    ...(data.modelBelowCosts ? { modelBelowCosts: true } : {}),
    ...(data.modelDisplayHold ? { modelDisplayHold: data.modelDisplayHold } : {}),
    ...(publicHeldRange(data) ? { modelHeldRange: publicHeldRange(data) } : {}),
    ...(data.analystRecoupPct ? {
      analystRecoupPct: data.analystRecoupPct,
      analystRecoupAsOf: data.analystRecoupAsOf ?? null,
      analystRecoupUrl: data.analystRecoupUrl ?? null,
    } : {}),
    ...(data.ourEstimateRangePct ? { ourEstimateRangePct: data.ourEstimateRangePct } : {}),
    ...(data.ourRecoupEstimatePct != null ? { ourRecoupEstimatePct: data.ourRecoupEstimatePct, ourRecoupEstimateAsOf: data.ourRecoupEstimateAsOf ?? null } : {}),
    ...(data.reportedReturn ? { reportedReturn: data.reportedReturn } : {}),
    ...(data.productionType ? { productionType: data.productionType } : {}),
    ...(conversionOf(data) ? { commercialConversion: conversionOf(data) } : {}),
    modelMethod: data.modelMethod || null,
    modelDataQuality: data.modelDataQuality,
    reportedMultiple: getReportedInvestorMultiple(data),
    estimatedReturnRange: getEstimatedReturnRange(data, show.status),
    // AllShowsTable is a client component: the row lands in the page payload, so only publishable text.
    recoupedSource: publicSourceText(data.recoupedSource),
    trend: running ? getRecoupmentTrend(slug) : 'unknown',
    recouped: data.recouped,
    recoupmentNotAnnounced: isUnannouncedRecoupment(data),
    recoupedWeeks: weeks.weeks,
    recoupedWeeksIsEstimate: weeks.isEstimate,
    recoupReportedAfterClosing: recoupReportedAfterClosing(data.recoupedDate, show.closingDate),
    lossCaveat: lossBasisCaveat(data),
    likelyOutcome: data.likelyOutcome ?? null,
    likelyOutcomeBasis: data.likelyOutcome ? (data.likelyOutcomeBasis ?? 'model') : null,
    designationBasis: data.designationBasis ?? null,
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
    if (showSeason !== season || !trackedRecord({ status: show.status, commercial: data })) continue;

    results.push(toCommercialShowRow(slug, show, data));
  }

  return results.sort((a, b) => {
    const orderDiff = getDesignationSortOrder(a.designation) - getDesignationSortOrder(b.designation);
    if (orderDiff !== 0) return orderDiff;
    return a.title.localeCompare(b.title);
  });
}

// ============================================
// Box Office Scorecard v2 (BRO-5007): status vs weekly cost
// ============================================
//
// Unreleased (owner, 2026-10-10: "Not public yet"). Callers gate every call on
// featureFlags.commercial && featureFlags.boxOfficeV2 in the page itself, so a
// flag-off build never computes these and the client receives nothing new.

/** What the v2 card and the /box-office table receive (everything here is publishable). */
export interface ShowBoxOfficeV2 extends ShowBoxOfficeStatus {
  title: string;
  slug: string;
  /** 'reported' when the cost cites a publishable source, else 'estimate'. */
  costBasis: 'reported' | 'estimate' | null;
  /** Publishable source text for the cost (publicSourceText), else null. */
  costSourceText: string | null;
  costSourceUrl: string | null;
  nonprofitOrg: string | null;
  /** hasNoInvestorsToRepay: the nonprofit note says "no investors to pay back" only then (an enhancement deal has them). */
  noInvestors: boolean;
  /** Final designation for a closed show (links to the Profitability Scorecard), else null. */
  designation: CommercialDesignation | null;
  /** Why a show has no usable cost (availability 'nocost' only), for the build report. */
  noCostReason: string | null;
}

/**
 * The one cost-basis answer the v2 card uses, for BOTH its Reported/Estimate
 * label and its range width, so they cannot disagree. Starts from the "~"
 * marker rule (isEstimatedRunningCost); a floor quote ("well over $1 million")
 * also reads Estimate, and a reported source over 24 months old keeps its
 * label but gets estimate width. v2 only: the existing pages keep their rule.
 */
export function getV2CostBasis(data: ShowCommercial, asOf: string): V2CostBasis {
  return v2CostBasis({
    costMethodology: data.costMethodology ?? null,
    estimated: isEstimatedRunningCost(data),
    sourceText: publicSourceText(data.weeklyRunningCostSource) ?? null,
    asOf,
  });
}

/** Why getBreakEven returns null for a record (null when it has a cost). */
export function noCostReason(data: ShowCommercial): string | null {
  if (getBreakEven(data) != null) return null;
  if (data.modelBreakeven && !meetsModelQualityFloor(data)) {
    return `no weekly cost on file; model break-even rejected by the quality floor (${data.modelDataQuality === 'low' ? 'low data quality' : `method ${data.modelMethod}`})`;
  }
  return 'no weekly cost or model break-even on file';
}

/** Market weeks the typical-show median covers (today's cost figures are wrong for older eras). */
const MARKET_MEDIAN_WEEKS = 156;
const PRODUCTION_LEAD_DAYS = 7;
const PRODUCTION_TAIL_DAYS = 7;

function isoDayOffset(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * This production's weeks, newest first, aligned to every Broadway week from
 * the latest one back to its first preview. History is keyed by slug, and a
 * revival can share a slug with an older production, so weeks outside this
 * production's dates are dropped.
 */
function productionWeeks(show: RawShow): WeekRow[] {
  const start = show.previewsStartDate || show.openingDate;
  const from = start ? isoDayOffset(start, -PRODUCTION_LEAD_DAYS) : null;
  const to = show.closingDate ? isoDayOffset(show.closingDate, PRODUCTION_TAIL_DAYS) : null;
  const rows: WeekRow[] = [];
  for (const week of WEEK_KEYS_NEWEST_FIRST) {
    if (from && week < from) break;
    const h = to && week > to ? undefined : grossesHistory.weeks[week]?.[show.slug];
    rows.push({
      week,
      gross: h?.gross ?? null,
      performances: h?.performances ?? null,
      attendance: h?.attendance ?? null,
      seatsOffered: h?.seatsOffered ?? null,
      atp: h?.atp ?? null,
      capacity: h?.capacity ?? null,
    });
  }
  return rows;
}

function isNonprofitRecord(data: ShowCommercial): boolean {
  // A nonprofit run that became a commercial run is a commercial production now (BRO-5508).
  if (isConvertedToCommercial(data)) return false;
  return data.designation === 'Nonprofit' || getNonprofitProducer(data) != null;
}

interface BoxOfficeV2Context {
  cost: CostProvider;
  market: Map<string, number>;
  latestWeek: string;
}

let boxOfficeV2Context: BoxOfficeV2Context | null = null;

/** Built once per build (per worker): the cost provider and the typical-show median. */
function getBoxOfficeV2Context(): BoxOfficeV2Context {
  if (boxOfficeV2Context) return boxOfficeV2Context;
  const latestWeek = WEEK_KEYS_NEWEST_FIRST[0];
  const cost = makeStaticCostProvider((slug) => {
    const data = commercial.shows[slug];
    return data ? { breakEven: getBreakEven(data), halfWidth: getV2CostBasis(data, latestWeek).halfWidth } : null;
  });
  const recent = new Set(WEEK_KEYS_NEWEST_FIRST.slice(0, MARKET_MEDIAN_WEEKS));
  const shows: Array<{ showId: string; nonprofit: boolean; weeks: WeekRow[] }> = [];
  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = rawShows.find((s) => s.slug === slug);
    if (!show || show.category !== 'broadway') continue;
    const weeks = productionWeeks(show).filter((r) => recent.has(r.week));
    // A run that switched to commercial adds only its commercial weeks; an undated switch adds none (BRO-5508).
    shows.push({ showId: slug, nonprofit: isNonprofitRecord(data), weeks: commercialRunWeeks(data, weeks) ?? weeks });
  }
  boxOfficeV2Context = { cost, market: computeMarketMedianByWeek(shows, cost), latestWeek };
  return boxOfficeV2Context;
}

let staleInputs: string[] | null = null;

/**
 * Stale-input reasons for this build (memoized). Non-empty means every v2
 * getter returns nothing and the build logs a loud error, so old inputs can
 * never publish statuses.
 */
export function getBoxOfficeV2StaleReasons(today: string = new Date().toISOString().slice(0, 10)): string[] {
  if (staleInputs) return staleInputs;
  staleInputs = staleInputReasons({
    historyNewestWeek: WEEK_KEYS_NEWEST_FIRST[0] ?? null,
    grossesWeekEnding: getGrossesWeekEnding() ?? null,
    commercialUpdated: commercial._meta?.lastUpdated ?? null,
    today,
  });
  if (staleInputs.length) {
    console.error(`[box-office-v2] STALE INPUTS, no statuses published this build: ${staleInputs.join('; ')}`);
  }
  return staleInputs;
}

/** Status for one Broadway show, or null when it has no commercial record or no grosses (or inputs are stale). */
export function getShowBoxOfficeV2(slug: string): ShowBoxOfficeV2 | null {
  if (getBoxOfficeV2StaleReasons().length) return null;
  const data = commercial.shows[slug];
  const show = rawShows.find((s) => s.slug === slug);
  if (!data || !show || show.category !== 'broadway') return null;
  const weeks = productionWeeks(show);
  if (!weeks.some((r) => r.gross != null)) return null;
  const ctx = getBoxOfficeV2Context();
  const status = computeShowStatus({
    showId: slug,
    status: show.status,
    closingDate: show.closingDate,
    nonprofit: isNonprofitRecord(data),
    weeks,
    cost: ctx.cost,
    marketMedianByWeek: ctx.market,
    latestWeek: ctx.latestWeek,
  });
  const atRisk = isAtRisk({
    status: show.status,
    recouped: data.recouped,
    recoupmentRange: getDisplayableModelRange({ ...data, status: show.status }),
    avgGross: trailingAverageGross(getRecentGrosses(slug, 4)),
    breakEven: getBreakEven(data),
  });
  status.band = reconcileWithAtRisk(status.band, atRisk);
  const hasCost = status.breakEven != null;
  const basis = getV2CostBasis(data, ctx.latestWeek);
  const reportedCost = hasCost && !basis.estimated;
  // A floor quote is an estimate but comes from a named public outlet, so it keeps its citation.
  const cited = reportedCost || (hasCost && basis.floorQuote);
  return {
    ...status,
    title: show.title,
    slug,
    costBasis: hasCost ? (reportedCost ? 'reported' : 'estimate') : null,
    costSourceText: cited ? publicSourceText(data.weeklyRunningCostSource) : null,
    costSourceUrl: cited ? getCitedSourceUrl(data.sources) : null,
    nonprofitOrg: getNonprofitProducer(data),
    noInvestors: hasNoInvestorsToRepay(data),
    designation: show.status === 'closed' && data.designation && data.designation !== 'TBD' ? data.designation : null,
    noCostReason: status.availability === 'nocost' ? noCostReason(data) : null,
  };
}

let boxOfficeV2ReportLogged = false;

/**
 * Status for every running Broadway show (open or previews) with a commercial
 * record and grosses, title order. Logs one build-time count per
 * availability/band plus the commercial records with no grosses history.
 */
export function getRunningBoxOfficeV2(): ShowBoxOfficeV2[] {
  const out: ShowBoxOfficeV2[] = [];
  for (const show of rawShows) {
    if (show.category !== 'broadway' || !isRunningStatus(show.status)) continue;
    const s = getShowBoxOfficeV2(show.slug);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  if (!boxOfficeV2ReportLogged) {
    boxOfficeV2ReportLogged = true;
    const historyKeys = new Set<string>();
    for (const w of Object.values(grossesHistory.weeks)) for (const k of Object.keys(w)) historyKeys.add(k);
    const noHistory = Object.keys(commercial.shows).filter((k) => !historyKeys.has(k));
    console.warn(`[box-office-v2] running shows: ${JSON.stringify(countStatuses(out))}; commercial records with no grosses history (${noHistory.length}): ${noHistory.join(', ')}`);
  }
  return out;
}

/**
 * /biz break-even bands (BRO-5007 v3): every running Broadway
 * show by break-even band, with each rated show's gross as a share of its
 * break-even (1.0 = covering costs). Null when nothing
 * is rated (stale inputs). The page gates the call on both flags.
 */
export function getBoxOfficeCostCoverage(): { counts: StatusCounts; shares: Record<string, number> } | null {
  const running = getRunningBoxOfficeV2();
  if (!running.length) return null;
  const known = new Set(running.map((r) => r.slug));
  const unrecorded = rawShows
    .filter((show) => show.category === 'broadway' && isRunningStatus(show.status) && !known.has(show.slug))
    .map((show) => ({ title: show.title, inPreviews: show.status === 'previews' }));
  const shares: Record<string, number> = {};
  for (const r of running) {
    const m = costStatusCell(r).sortValue;
    if (m != null) shares[r.title] = m;
  }
  return { counts: statusCounts(running, unrecorded), shares };
}

// Box Office v3 (BRO-5007): the market numbers read history through one input,
// built once per build. Held like the rest: callers gate on both flags.
let boxOfficeMarketInput: MarketInput | null = null;

/** Every week of Broadway history plus its shows, for the pure maths in box-office-market. */
export function getBoxOfficeMarketInput(): MarketInput {
  if (!boxOfficeMarketInput) {
    boxOfficeMarketInput = {
      weeks: grossesHistory.weeks as unknown as HistoryWeeks,
      shows: new Map(rawShows.filter((s) => s.category === 'broadway').map((s) => [s.slug, s as MarketShow])),
    };
  }
  return boxOfficeMarketInput;
}

/** One show's Box Office Scorecard numbers (Broadway League facts only), or null with no reported week in the last year. */
export function getBoxOfficeFacts(slug: string): ShowFacts | null {
  const latest = WEEK_KEYS_NEWEST_FIRST[0];
  return latest ? showFacts(getBoxOfficeMarketInput(), slug, latest) : null;
}

let boxOfficeMarketPage: MarketPage | null | undefined;

/** The /box-office market page for the latest reported week, built once per build. */
export function getBoxOfficeMarketPage(): MarketPage | null {
  if (boxOfficeMarketPage === undefined) {
    const latest = WEEK_KEYS_NEWEST_FIRST[0];
    boxOfficeMarketPage = latest
      ? buildMarketPage(getBoxOfficeMarketInput(), latest, { designationOf: (slug) => commercial.shows[slug]?.designation ?? null })
      : null;
  }
  return boxOfficeMarketPage;
}
