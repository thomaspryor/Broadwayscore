// Box Office Scorecard v2 (BRO-5007): is a show's weekly gross covering its
// weekly cost? Pure functions only. data-commercial.ts feeds them from
// commercial.json / grosses-history.json / shows.json behind
// featureFlags.commercial && featureFlags.boxOfficeV2, and the unit tests
// (tests/unit/box-office-status.test.ts) call them with fixtures.
//
// Unreleased: the owner has not made this public (2026-10-10). Nothing here
// may reach public/data/shows/*.json, llms.txt, the sitemap or the iOS feed.

import type { RecoupmentTrend } from '@/config/commercial';
import { computeGrossTrend, getSeason, trailingAverageGross } from './commercial-metrics';
import { isReported } from './box-office-weeks';
import { MAX_GROSSES_AGE_DAYS, calendarDaysBetween, mdyToIso } from './grosses-week';

// ---------------------------------------------------------------------------
// Cost contract
// ---------------------------------------------------------------------------

/** Source quality of a weekly cost, same labels as costForWeek (scripts/lib/cost-for-week.js). */
export type CostQuality = 'high' | 'medium' | 'low' | 'estimated';

/**
 * One week's cost, in BRO-4989's costForWeek() shape: `low`/`high` bound the
 * running cost; the multiple's range applies the same relative width to the
 * break-even.
 */
export interface WeekCost {
  cost: number;
  breakEven: number;
  low: number;
  high: number;
  quality: CostQuality;
}

/** (showId, weekEnding) -> that week's cost, or null when we have none. */
export type CostProvider = (showId: string, weekEnding: string) => WeekCost | null;

/**
 * A cost at or below this quality gets no status. 'estimated' is costForWeek's
 * label for a category guess with no figure for the show at all.
 */
export function meetsCostQualityFloor(quality: CostQuality | null | undefined): boolean {
  return quality === 'high' || quality === 'medium' || quality === 'low';
}

/** Range half-width by costMethodology (v1 provider). Unknown or missing values get the widest. */
export const COST_METHOD_HALF_WIDTH: Readonly<Record<string, number>> = {
  'trade-reported': 0.05,
  'sec-filing': 0.05,
  'producer-confirmed': 0.05,
  'reddit-standard': 0.15,
  'industry-estimate': 0.2,
  'deep-research': 0.2,
};
export const DEFAULT_COST_HALF_WIDTH = 0.2;
/** Narrowest width any cost the card labels "Estimate" can get. */
export const MIN_ESTIMATE_HALF_WIDTH = 0.15;

/**
 * Range half-width for a cost. `estimated` is the same flag that picks the
 * card's "Reported"/"Estimate" label (isEstimatedRunningCost), so the two can
 * never disagree: a reported cost gets its method's width, an estimate never
 * narrower than MIN_ESTIMATE_HALF_WIDTH (an uncited "trade-reported" figure
 * reads Estimate and gets the default width).
 */
export function costHalfWidth(costMethodology: string | null | undefined, estimated: boolean): number {
  const byMethod = (costMethodology && COST_METHOD_HALF_WIDTH[costMethodology]) || DEFAULT_COST_HALF_WIDTH;
  if (!estimated) return byMethod;
  return byMethod >= MIN_ESTIMATE_HALF_WIDTH ? byMethod : DEFAULT_COST_HALF_WIDTH;
}

/** A reported cost older than this gets estimate width (costForWeek will age costs itself). */
export const REPORTED_SOURCE_MAX_AGE_MONTHS = 24;

/** A quote that only gives a lower bound ("well over $1 million") is not a reported figure. */
const FLOOR_QUOTE_RE = /\b(?:more than|well over|(?<!turned |rolled |carried )over|at least|north of|upwards of|in excess of|exceed(?:s|ed|ing)?|top(?:s|ped|ping))\s+(?:about\s+|roughly\s+)?\$/i;

/** "Broadway Journal (Nov 6, 2023): ..." -> "2023-11-06"; null when the source names no parseable date. */
export function costSourceDate(sourceText: string): string | null {
  const head = sourceText.split(':')[0];
  const iso = head.match(/\((?:[^()]*\D)?((?:19|20)\d{2}-\d{2}-\d{2})\)/);
  if (iso) return iso[1];
  const m = head.match(/\(([^()]*\b(?:19|20)\d{2})\)/);
  if (!m) return null;
  const t = Date.parse(`${m[1]} 12:00 UTC`);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export interface V2CostBasis {
  /** Drives the card's Reported/Estimate label. */
  estimated: boolean;
  /** Range half-width for the multiple. */
  halfWidth: number;
  /** The source quote is a lower bound, so the figure reads as an estimate. */
  floorQuote: boolean;
  /** Reported, but the source is older than REPORTED_SOURCE_MAX_AGE_MONTHS: keeps the label, gets estimate width. */
  aged: boolean;
}

/**
 * The one answer the v2 card uses for both its label and its range width.
 * `estimated` is the record's own estimate flag (isEstimatedRunningCost);
 * `sourceText` the publishable source; `asOf` the latest grosses week.
 */
export function v2CostBasis(input: {
  costMethodology?: string | null;
  estimated: boolean;
  sourceText: string | null;
  asOf: string;
}): V2CostBasis {
  if (input.estimated || !input.sourceText) {
    return { estimated: true, halfWidth: costHalfWidth(input.costMethodology, true), floorQuote: false, aged: false };
  }
  const floorQuote = FLOOR_QUOTE_RE.test(input.sourceText);
  const date = costSourceDate(input.sourceText);
  let aged = false;
  if (date) {
    const limit = new Date(`${date}T12:00:00Z`);
    limit.setUTCMonth(limit.getUTCMonth() + REPORTED_SOURCE_MAX_AGE_MONTHS);
    aged = limit.toISOString().slice(0, 10) < input.asOf;
  }
  const reportedWidth = costHalfWidth(input.costMethodology, false);
  const halfWidth = floorQuote || aged ? Math.max(reportedWidth, MIN_ESTIMATE_HALF_WIDTH) : reportedWidth;
  return { estimated: floorQuote, halfWidth, floorQuote, aged };
}

/** Same bands as costForWeek's qualityFor(). */
export function qualityForHalfWidth(halfWidth: number): CostQuality {
  if (halfWidth <= 0.10 + 1e-9) return 'high';
  if (halfWidth <= 0.18 + 1e-9) return 'medium';
  return 'low';
}

/**
 * v1 provider: one break-even (getBreakEven, which already applies the model
 * quality floor) for every week, with the range width from v2CostBasis.
 * Swapping in costForWeek later happens behind a shadow diff.
 */
export function makeStaticCostProvider(
  lookup: (showId: string) => { breakEven: number | null; halfWidth: number } | null | undefined,
): CostProvider {
  return (showId) => {
    const rec = lookup(showId);
    const be = rec?.breakEven;
    if (!rec || be == null || !(be > 0)) return null;
    const hw = rec.halfWidth;
    return { cost: be, breakEven: be, low: be * (1 - hw), high: be * (1 + hw), quality: qualityForHalfWidth(hw) };
  };
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

export type CostBand = 'well-above' | 'above' | 'near' | 'below';

export const WELL_ABOVE_MIN = 2.0;
export const ABOVE_MIN = 1.15;
export const NEAR_MIN = 0.95;

export interface MultipleRange {
  lo: number;
  mid: number;
  hi: number;
}

/** Gross over a week's cost as a range; null when the cost can't support one. */
export function multipleFor(gross: number, wc: WeekCost | null): MultipleRange | null {
  if (!wc || !(wc.breakEven > 0) || !(wc.cost > 0) || !Number.isFinite(gross)) return null;
  const relLow = wc.low / wc.cost;
  const relHigh = wc.high / wc.cost;
  if (!(relLow > 0) || !(relHigh >= relLow)) return null;
  return {
    mid: gross / wc.breakEven,
    lo: gross / (wc.breakEven * relHigh),
    hi: gross / (wc.breakEven * relLow),
  };
}

/**
 * One precedence order, first match wins:
 *   1. range includes 1.0            -> near  (never Below/Above on a range that straddles cost)
 *   2. mid >= 2.0                    -> well-above
 *   3. 0.95 <= mid < 1.15            -> near
 *   4. hi < 1.0 (whole range under)  -> below
 *   5. mid >= 1.15 (lo > 1 by now)   -> above
 *   6. anything else (NaN etc.)      -> near
 */
export function classifyMultiple(lo: number, mid: number, hi: number): CostBand {
  if (lo <= 1 && hi >= 1) return 'near';
  if (mid >= WELL_ABOVE_MIN) return 'well-above';
  if (mid >= NEAR_MIN && mid < ABOVE_MIN) return 'near';
  if (hi < 1) return 'below';
  if (mid >= ABOVE_MIN) return 'above';
  return 'near';
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/** One Broadway week for one show; null figures mean the show did not report. */
export interface WeekRow {
  week: string; // YYYY-MM-DD week ending
  gross: number | null;
  performances?: number | null;
  attendance?: number | null;
  seatsOffered?: number | null;
  atp?: number | null;
  capacity?: number | null;
}

/** The COVID shutdown: shown as a gap, never zero, never breaks or extends a streak. */
export const SHUTDOWN_START = '2020-03-12';
export const SHUTDOWN_END = '2021-09-30';
export function isShutdownWeek(week: string): boolean {
  return week >= SHUTDOWN_START && week <= SHUTDOWN_END;
}

export const STATUS_WINDOW_WEEKS = 4;
/** A reported week with fewer performances is a partial week (previews, shutdown, holiday dark days). */
export const FULL_WEEK_PERFORMANCES = 8;
/** Partial weeks among a run's first this-many reported weeks are left out of the status window. */
export const PREVIEW_WEEKS = 4;

/** The shared reported-week rule (box-office-weeks isReported), never a local copy. */
function reported(r: WeekRow | undefined): r is WeekRow & { gross: number } {
  return isReported(r);
}

/**
 * The 4-week window's grosses (newest first), with null for a week that does
 * not count: unreported, a partial preview week (fewer than 8 performances
 * among the run's first 4 reported weeks), or a week listing 0 performances
 * beside a gross anywhere in the run (an unknown count, usually a long
 * preview period; BRO-5057). Later short weeks (a 7-show play schedule, a
 * holiday) count as reported.
 */
export function statusWindowGrosses(weeksNewestFirst: WeekRow[]): Array<number | null> {
  const reportedOldestFirst = weeksNewestFirst.filter(reported).map((r) => r.week).reverse();
  const previewWeeks = new Set(reportedOldestFirst.slice(0, PREVIEW_WEEKS));
  return weeksNewestFirst.slice(0, STATUS_WINDOW_WEEKS).map((r) => {
    if (!reported(r)) return null;
    const perfs = r.performances;
    if (perfs === 0) return null;
    if (previewWeeks.has(r.week) && typeof perfs === 'number' && perfs < FULL_WEEK_PERFORMANCES) return null;
    return r.gross;
  });
}

export interface MultiplePoint {
  week: string;
  gross: number | null;
  /** gross / break-even; null for an unreported or shutdown week (drawn as a gap). */
  multiple: number | null;
  /** Typical Broadway show that week (median multiple), null when unknown. */
  market: number | null;
}

/** Weekly multiples, newest first, one point per week given. */
export function buildMultipleSeries(
  showId: string,
  weeksNewestFirst: WeekRow[],
  cost: CostProvider,
  marketMedianByWeek: ReadonlyMap<string, number> | null,
): MultiplePoint[] {
  return weeksNewestFirst.map((r) => {
    const shut = isShutdownWeek(r.week);
    const wc = !shut && reported(r) ? cost(showId, r.week) : null;
    const m = wc && meetsCostQualityFloor(wc.quality) && reported(r) ? multipleFor(r.gross, wc) : null;
    return {
      week: r.week,
      gross: shut || !reported(r) ? null : r.gross,
      multiple: m ? m.mid : null,
      market: marketMedianByWeek?.get(r.week) ?? null,
    };
  });
}

export interface Streak {
  side: 'above' | 'below';
  weeks: number;
  /** True when the streak runs past the look-back window: "at least `weeks`". */
  atLeast: boolean;
}

/**
 * Consecutive weeks on the same side of cost, counted back from the newest
 * week with a multiple, over at most `maxWeeks` weeks (today's cost figure is
 * no guide to a long run's early years). Shutdown weeks are skipped (they
 * neither break nor extend it); any other week without a multiple ends it.
 */
export function currentStreak(seriesNewestFirst: MultiplePoint[], maxWeeks = Infinity): Streak | null {
  let side: Streak['side'] | null = null;
  let weeks = 0;
  let broke = false;
  const window = seriesNewestFirst.slice(0, maxWeeks);
  for (const p of window) {
    if (isShutdownWeek(p.week)) continue;
    if (p.multiple == null) {
      if (side == null) continue; // leading unreported weeks (a dark latest week) don't end it
      broke = true;
      break;
    }
    const s: Streak['side'] = p.multiple < 1 ? 'below' : 'above';
    if (side == null) side = s;
    if (s !== side) {
      broke = true;
      break;
    }
    weeks++;
  }
  if (!side) return null;
  // "At least" only when the week just past the window continues the streak.
  const next = broke ? undefined : seriesNewestFirst.slice(window.length).find((p) => !isShutdownWeek(p.week));
  const atLeast = !!next && next.multiple != null && (next.multiple < 1 ? 'below' : 'above') === side;
  return { side, weeks, atLeast };
}

/** Median of the values, null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Typical Broadway show per week: the median multiple across shows with a
 * cost that week, nonprofits excluded (their cost model differs). Call once
 * per build; callers memoize the result.
 */
export function computeMarketMedianByWeek(
  shows: Array<{ showId: string; nonprofit: boolean; weeks: WeekRow[] }>,
  cost: CostProvider,
): Map<string, number> {
  const byWeek = new Map<string, number[]>();
  for (const s of shows) {
    if (s.nonprofit) continue;
    for (const r of s.weeks) {
      if (!reported(r) || isShutdownWeek(r.week)) continue;
      const wc = cost(s.showId, r.week);
      if (!wc || !meetsCostQualityFloor(wc.quality)) continue;
      const m = multipleFor(r.gross, wc);
      if (!m) continue;
      const list = byWeek.get(r.week) ?? [];
      list.push(m.mid);
      byWeek.set(r.week, list);
    }
  }
  const out = new Map<string, number>();
  byWeek.forEach((vals, week) => {
    const med = median(vals);
    if (med != null) out.set(week, med);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Closed runs
// ---------------------------------------------------------------------------

/** Runs at least this long are summarized by season instead of week by week. */
export const SEASON_VIEW_MIN_WEEKS = 104;

export interface SeasonSummary {
  season: string;
  weeks: number;
  gross: number;
}

export interface ClosedRunSummary {
  granularity: 'weekly' | 'season';
  weeksReported: number;
  totalGross: number;
  /** Weeks with a multiple (a cost for that week); weekly view only until era costs exist. */
  weeksWithCost: number;
  weeksBelow: number;
  weeksAbove: number;
  /** Weekly view: oldest first, shutdown weeks dropped. */
  series: MultiplePoint[];
  /** Season view: oldest first. Totals only until BRO-4989 era costs exist. */
  seasons: SeasonSummary[];
}

/**
 * Whole-run summary for a closed show. Under 104 reported weeks it is a weekly
 * series against the cost; at 104+ it is grosses by season with no multiples,
 * because today's single cost figure is wrong for a run's early years.
 */
export function summarizeClosedRun(seriesNewestFirst: MultiplePoint[]): ClosedRunSummary {
  const played = seriesNewestFirst.filter((p) => p.gross != null && !isShutdownWeek(p.week)).reverse();
  const totalGross = played.reduce((a, p) => a + (p.gross as number), 0);
  const granularity = played.length >= SEASON_VIEW_MIN_WEEKS ? 'season' : 'weekly';
  if (granularity === 'season') {
    const bySeason = new Map<string, SeasonSummary>();
    for (const p of played) {
      const season = getSeason(p.week) ?? 'unknown';
      const s = bySeason.get(season) ?? { season, weeks: 0, gross: 0 };
      s.weeks++;
      s.gross += p.gross as number;
      bySeason.set(season, s);
    }
    return {
      granularity, weeksReported: played.length, totalGross,
      weeksWithCost: 0, weeksBelow: 0, weeksAbove: 0, series: [], seasons: Array.from(bySeason.values()),
    };
  }
  const withCost = played.filter((p) => p.multiple != null);
  return {
    granularity,
    weeksReported: played.length,
    totalGross,
    weeksWithCost: withCost.length,
    weeksBelow: withCost.filter((p) => (p.multiple as number) < 1).length,
    weeksAbove: withCost.filter((p) => (p.multiple as number) >= 1).length,
    series: played,
    seasons: [],
  };
}

// ---------------------------------------------------------------------------
// One show
// ---------------------------------------------------------------------------

export type Availability = 'ok' | 'nocost' | 'early' | 'closed' | 'closing';

/** An announced closing within this many days of the latest week: final weeks, no status chip. */
export const CLOSING_WINDOW_DAYS = 28;

export interface CoverCosts {
  /** Trailing 4-week average gross. */
  avgGross: number;
  breakEven: number;
  /** Break-even minus average gross (0 when covering). */
  shortBy: number;
  /** Average ticket needed at the window's average attendance, null when unknown. */
  ticketNeeded: number | null;
  ticketNow: number | null;
  /** Capacity (%) needed at the window's average ticket price, null when unknown. */
  capacityNeeded: number | null;
  capacityNow: number | null;
}

export interface ShowBoxOfficeStatus {
  availability: Availability;
  band: CostBand | null;
  multiple: MultipleRange | null;
  trend: RecoupmentTrend;
  streak: Streak | null;
  /** Reported weeks in this production's run. */
  weeksReported: number;
  breakEven: number | null;
  quality: CostQuality | null;
  nonprofit: boolean;
  closingDate: string | null;
  /** Last 52 weeks, oldest first (the chart). */
  series: MultiplePoint[];
  cover: CoverCosts | null;
  closedRun: ClosedRunSummary | null;
  story: string | null;
}

export interface ShowStatusInput {
  showId: string;
  status: string | null | undefined;
  closingDate?: string | null;
  nonprofit: boolean;
  /** This production's weeks, newest first, aligned to every Broadway week from the latest market week back. */
  weeks: WeekRow[];
  cost: CostProvider;
  marketMedianByWeek: ReadonlyMap<string, number> | null;
  /** Latest Broadway week ending (YYYY-MM-DD). */
  latestWeek: string;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function avg(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** What it would take to cover cost, from the same window as the status. */
export function computeCoverCosts(windowRows: WeekRow[], avgGross: number, breakEven: number): CoverCosts {
  const attendance = avg(windowRows.map((r) => r.attendance));
  const seats = avg(windowRows.map((r) => r.seatsOffered));
  const ticketNow = attendance ? avgGross / attendance : null;
  const capacityNow = attendance && seats ? (attendance / seats) * 100 : null;
  return {
    avgGross,
    breakEven,
    shortBy: Math.max(0, breakEven - avgGross),
    ticketNeeded: attendance ? breakEven / attendance : null,
    ticketNow,
    capacityNeeded: ticketNow && seats ? (breakEven / ticketNow / seats) * 100 : null,
    capacityNow,
  };
}

/**
 * How the window's gross compares with break-even, from the multiple itself (the
 * band can be Near on a range that straddles 1.0 while the midpoint is 0.86,
 * and "close to" would then sit beside "19 straight weeks below break-even").
 */
export function multiplePhrase(mid: number): string {
  if (mid > WELL_ABOVE_MIN + 0.005) return 'more than double what it needs to break even';
  if (mid >= 1.9) return 'about double what it needs to break even';
  if (mid >= NEAR_MIN && mid <= 1.05) return 'close to what it needs to break even';
  const pct = Math.round(Math.abs(mid - 1) * 100);
  return mid > 1 ? `about ${pct}% more than it needs to break even` : `about ${pct}% less than it needs to break even`;
}

/**
 * One or two plain descriptive sentences. Never causal ("the slump is this
 * show's"): it states the show's numbers and, when known, how the typical
 * show did over the same weeks. Null for nocost / early / closing / closed.
 */
export function buildStory(s: Pick<ShowBoxOfficeStatus, 'availability' | 'band' | 'multiple' | 'streak' | 'series'>): string | null {
  if (s.availability !== 'ok' || !s.band || !s.multiple) return null;
  const first = `Over the last ${STATUS_WINDOW_WEEKS} weeks it grossed ${multiplePhrase(s.multiple.mid)}.`;
  const streak = s.streak;
  if (!streak || streak.weeks < 2) return first;
  const streakWeeks = s.series
    .slice()
    .reverse()
    .filter((p) => p.multiple != null && !isShutdownWeek(p.week))
    .slice(0, streak.weeks);
  const withMarket = streakWeeks.filter((p) => p.market != null);
  // The streak itself prints beside the story; the story adds how the typical show did.
  if (streakWeeks.length !== streak.weeks || withMarket.length !== streak.weeks) return first;
  const marketAbove = withMarket.filter((p) => (p.market as number) >= 1).length;
  return `${first} The typical Broadway show was at or above break-even in ${marketAbove} of those ${streak.weeks} weeks.`;
}

export const CHART_WEEKS = 52;

export function computeShowStatus(input: ShowStatusInput): ShowBoxOfficeStatus {
  const { showId, weeks, cost, latestWeek } = input;
  const seriesAll = buildMultipleSeries(showId, weeks, cost, input.marketMedianByWeek);
  const weeksReported = weeks.filter((r) => reported(r) && !isShutdownWeek(r.week)).length;
  const grossesNewestFirst = weeks.map((r) => (reported(r) ? r.gross : null));
  const trend = computeGrossTrend(grossesNewestFirst);
  const latestCost = cost(showId, latestWeek);
  const usableCost = latestCost && meetsCostQualityFloor(latestCost.quality) ? latestCost : null;
  const closingDate = input.closingDate ?? null;
  const base: ShowBoxOfficeStatus = {
    availability: 'ok', band: null, multiple: null, trend, streak: null, weeksReported,
    breakEven: usableCost?.breakEven ?? null, quality: usableCost?.quality ?? null,
    nonprofit: input.nonprofit, closingDate,
    series: seriesAll.slice(0, CHART_WEEKS).reverse(), cover: null, closedRun: null, story: null,
  };

  if (input.status === 'closed') {
    return { ...base, availability: 'closed', trend: 'unknown', closedRun: summarizeClosedRun(seriesAll) };
  }
  if (closingDate && latestWeek && daysBetween(latestWeek, closingDate) <= CLOSING_WINDOW_DAYS) {
    return { ...base, availability: 'closing' };
  }
  const windowGrosses = statusWindowGrosses(weeks);
  const avgGross = weeksReported >= STATUS_WINDOW_WEEKS ? trailingAverageGross(windowGrosses, STATUS_WINDOW_WEEKS) : null;
  if (avgGross == null) return { ...base, availability: 'early' };
  if (!usableCost) return { ...base, availability: 'nocost' };
  const multiple = multipleFor(avgGross, usableCost);
  if (!multiple) return { ...base, availability: 'nocost' };
  const band = classifyMultiple(multiple.lo, multiple.mid, multiple.hi);
  const windowRows = weeks.slice(0, STATUS_WINDOW_WEEKS).filter((r, i) => windowGrosses[i] != null);
  const out: ShowBoxOfficeStatus = {
    ...base,
    band,
    multiple,
    streak: currentStreak(seriesAll, CHART_WEEKS),
    cover: computeCoverCosts(windowRows, avgGross, usableCost.breakEven),
  };
  out.story = buildStory(out);
  return out;
}

/**
 * /biz lists a show At Risk when its 4-week average is under break-even. The
 * status window can differ slightly (partial preview weeks are left out), so
 * an At Risk show never reads Above here: it is capped at Near.
 */
export function reconcileWithAtRisk(band: CostBand | null, atRisk: boolean): CostBand | null {
  if (atRisk && (band === 'above' || band === 'well-above')) return 'near';
  return band;
}

/** Build-time counts per availability and band (logged once per build). */
export function countStatuses(statuses: Array<Pick<ShowBoxOfficeStatus, 'availability' | 'band'>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    const k = s.availability === 'ok' ? `ok:${s.band}` : s.availability;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Input freshness. A build reading an old grosses-history or commercial.json
// (a stale local clone, a half-synced checkout) must not publish statuses: the
// Phase 1 table was computed on 6-day-old inputs and every number moved.

export { MAX_GROSSES_AGE_DAYS };
/** commercial.json is refreshed weekly; older than this relative to the newest grosses week is stale. */
export const MAX_COMMERCIAL_LAG_DAYS = 14;

export interface FreshnessInput {
  /** Newest week key in grosses-history.json (YYYY-MM-DD). */
  historyNewestWeek: string | null;
  /** grosses.json weekEnding (M/D/YYYY as stored). */
  grossesWeekEnding: string | null;
  /** commercial.json _meta.lastUpdated (ISO). */
  commercialUpdated: string | null;
  /** Build date (YYYY-MM-DD). */
  today: string;
}

/** Empty list = fresh. Each entry says what is stale and by how much. */
export function staleInputReasons(input: FreshnessInput): string[] {
  const reasons: string[] = [];
  const newest = input.historyNewestWeek;
  if (!newest) return ['grosses-history.json has no weeks'];
  const age = calendarDaysBetween(newest, input.today);
  if (age > MAX_GROSSES_AGE_DAYS) {
    reasons.push(`newest grosses week ${newest} is ${age} days old (max ${MAX_GROSSES_AGE_DAYS})`);
  }
  const current = mdyToIso(input.grossesWeekEnding);
  if (current && current !== newest) {
    reasons.push(`grosses.json week ${current} does not match grosses-history.json newest week ${newest}`);
  }
  if (!input.commercialUpdated) {
    reasons.push('commercial.json has no _meta.lastUpdated');
  } else {
    const lag = daysBetween(input.commercialUpdated.slice(0, 10), newest);
    if (lag > MAX_COMMERCIAL_LAG_DAYS) {
      reasons.push(`commercial.json updated ${input.commercialUpdated.slice(0, 10)}, ${lag} days before the newest grosses week`);
    }
  }
  return reasons;
}
