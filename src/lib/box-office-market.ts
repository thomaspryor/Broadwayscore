// Market-wide numbers for the Box Office v3 page (BRO-5007): the week's total,
// season to date, movers, gross per seat, sell-out streaks, premium pull,
// historic pace and the new-musical cohort. Pure: callers pass the history
// and a show index, tests pass fixtures. Numbers only; every sentence lives in
// the display module.

import {
  addDays,
  daysBetween,
  grossPerSeat,
  isPaired,
  isFullWeek,
  MIN_FULL_WEEK_PERFORMANCES,
  isReported,
  lastReportedWeeks,
  median,
  pctChange,
  priorSeason,
  quantile,
  seasonFirstWeek,
  seasonOfWeek,
  weekOfSeason,
  yearAgoWeek,
  TRAILING_WEEKS,
  type HistoryRow,
  type HistoryWeeks,
} from './box-office-weeks';
import { SHUTDOWN_START, SHUTDOWN_END } from './box-office-status';

/** The show fields these functions read, indexed by production slug. */
export interface MarketShow {
  slug: string;
  title: string;
  category: string;
  type?: string | null;
  isRevival?: boolean | null;
  previewsStartDate?: string | null;
  openingDate?: string | null;
}

export interface MarketInput {
  weeks: HistoryWeeks;
  /** Production slug → show. A slug missing here still counts as Broadway (history only holds Broadway). */
  shows: Map<string, MarketShow>;
}

/** History begins with this week; runs that started earlier have no first weeks to compare. */
export const HISTORY_START = '2001-12-16';

function isBroadwaySlug(input: MarketInput, slug: string): boolean {
  const show = input.shows.get(slug);
  return !show || show.category === 'broadway';
}

function rowFor(input: MarketInput, slug: string) {
  return (week: string): HistoryRow | undefined => input.weeks[week]?.[slug];
}

// ------------------------------------------------------------------
// The week and the season
// ------------------------------------------------------------------

export interface WeekShare {
  slug: string;
  gross: number;
}

export interface MarketWeek {
  week: string;
  gross: number;
  shows: number;
  /** Reporting shows, highest gross first. */
  ranked: WeekShare[];
}

/** Every reported Broadway row of one week, or null when the week has none. */
export function marketWeek(input: MarketInput, week: string): MarketWeek | null {
  const rows = input.weeks[week];
  if (!rows) return null;
  const ranked: WeekShare[] = [];
  for (const [slug, row] of Object.entries(rows)) {
    if (!isReported(row) || !isBroadwaySlug(input, slug)) continue;
    ranked.push({ slug, gross: row.gross });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.gross - a.gross || a.slug.localeCompare(b.slug));
  return { week, gross: ranked.reduce((s, r) => s + r.gross, 0), shows: ranked.length, ranked };
}

/** A year-ago week counts only when at least half as many shows reported (a partly backfilled week would mislead). */
function comparableTotal(input: MarketInput, week: string | null, shows: number): MarketWeek | null {
  if (!week) return null;
  const w = marketWeek(input, week);
  return w && w.shows * 2 >= shows ? w : null;
}

export interface SeasonToDate {
  season: string;
  /** Week-of-season of the latest week (1-based). */
  weeks: number;
  /** Null when any week of this season so far is missing from the history. */
  gross: number | null;
  /** The same number of weeks of each earlier season, newest first; null when that season is incomplete. */
  prior: Array<{ season: string; gross: number | null }>;
}

/**
 * Totals of the first `n` weeks of a season, null when any of those weeks is
 * missing or the season is shorter than `n` weeks (a 53-week season compared
 * with a 52-week one must not borrow the next season's first week).
 */
export function seasonGrossThrough(input: MarketInput, season: string, n: number): number | null {
  let gross = 0;
  const first = seasonFirstWeek(season);
  const next = seasonFirstWeek(priorSeason(season, -1));
  for (let i = 0; i < n; i++) {
    const wk = addDays(first, 7 * i);
    if (wk >= next) return null;
    const w = marketWeek(input, wk);
    if (!w) return null;
    gross += w.gross;
  }
  return gross;
}

export function seasonToDate(input: MarketInput, week: string, priorSeasons = 2): SeasonToDate {
  const season = seasonOfWeek(week);
  const n = weekOfSeason(week);
  const prior = [];
  for (let k = 1; k <= priorSeasons; k++) {
    const s = priorSeason(season, k);
    prior.push({ season: s, gross: seasonGrossThrough(input, s, n) });
  }
  return { season, weeks: n, gross: seasonGrossThrough(input, season, n), prior };
}

export interface MarketSummary {
  week: string;
  gross: number;
  shows: number;
  lastWeekGross: number | null;
  lastWeekPct: number | null;
  lastYearWeek: string | null;
  lastYearGross: number | null;
  lastYearPct: number | null;
  /** Share of the week's gross taken by the top four, 0..1. */
  topFourShare: number;
  ranked: WeekShare[];
  season: SeasonToDate;
}

export function marketSummary(input: MarketInput, week: string): MarketSummary | null {
  const now = marketWeek(input, week);
  if (!now) return null;
  const lastWeek = comparableTotal(input, addDays(week, -7), now.shows);
  const ly = comparableTotal(input, yearAgoWeek((w) => !!input.weeks[w], week), now.shows);
  const top4 = now.ranked.slice(0, 4).reduce((s, r) => s + r.gross, 0);
  return {
    week,
    gross: now.gross,
    shows: now.shows,
    lastWeekGross: lastWeek?.gross ?? null,
    lastWeekPct: pctChange(now.gross, lastWeek?.gross),
    lastYearWeek: ly?.week ?? null,
    lastYearGross: ly?.gross ?? null,
    lastYearPct: pctChange(now.gross, ly?.gross),
    topFourShare: now.gross > 0 ? top4 / now.gross : 0,
    ranked: now.ranked,
    season: seasonToDate(input, week),
  };
}

export interface SeasonSeries {
  season: string;
  /** Index i = week-of-season i+1; null where the week is missing. */
  gross: Array<number | null>;
}

/** Weekly Broadway totals by week of season, up to `throughWeek` (inclusive) when given. */
export function seasonSeries(input: MarketInput, season: string, throughWeek?: string): SeasonSeries {
  const first = seasonFirstWeek(season);
  const next = seasonFirstWeek(priorSeason(season, -1));
  const gross: Array<number | null> = [];
  for (let w = first; w < next && (!throughWeek || w <= throughWeek); w = addDays(w, 7)) {
    gross.push(marketWeek(input, w)?.gross ?? null);
  }
  return { season, gross };
}

/** Per week-of-season min and max over the given seasons' series (null where none has data). */
export function seriesRange(series: SeasonSeries[]): Array<{ min: number; max: number } | null> {
  const len = Math.max(0, ...series.map((s) => s.gross.length));
  const out: Array<{ min: number; max: number } | null> = [];
  for (let i = 0; i < len; i++) {
    const v = series.map((s) => s.gross[i]).filter((x): x is number => x != null);
    out.push(v.length ? { min: Math.min(...v), max: Math.max(...v) } : null);
  }
  return out;
}

// ------------------------------------------------------------------
// Movers
// ------------------------------------------------------------------

export interface Mover {
  slug: string;
  gross: number;
  prevGross: number;
  pct: number;
  performances: number | null;
  prevPerformances: number | null;
  /** Change in gross per performance when the count changed, else null. */
  perShowPct: number | null;
  capacity: number | null;
}

/**
 * Whether a week-over-week move says something about demand. False when the
 * base week was partial, or when the gross moved one way only because the
 * show played more or fewer times while per-performance takings moved the
 * other way (a "gain" that is really added previews).
 */
export function isScheduleMove(pct: number, prevPerfs: number | null, perShowPct: number | null): boolean {
  if (prevPerfs != null && prevPerfs < MIN_FULL_WEEK_PERFORMANCES) return false;
  if (perShowPct != null && Math.sign(perShowPct) !== Math.sign(pct)) return false;
  return true;
}

/** A move under this many percent (either way) is noise, not a mover; the list runs short rather than show "▼0%". */
export const MOVER_MIN_PCT = 2;

/**
 * Week-over-week changes for shows that reported both weeks. A show's first
 * reported week is never a mover (the prior week must be reported too), and
 * a base under $10K gives no percent.
 */
export function movers(input: MarketInput, week: string, n = 4): { gains: Mover[]; drops: Mover[] } {
  const prevWeek = addDays(week, -7);
  const all: Mover[] = [];
  for (const [slug, row] of Object.entries(input.weeks[week] ?? {})) {
    if (!isReported(row) || !isBroadwaySlug(input, slug)) continue;
    const prev = input.weeks[prevWeek]?.[slug];
    if (!isReported(prev)) continue;
    const pct = pctChange(row.gross, prev.gross);
    if (pct == null) continue;
    // A listed 0 beside a gross is an unknown count (isReported): never printed
    // as "0 shows". Last week's 0 stays 0 so isScheduleMove rejects it as a base.
    const perfs = row.performances || null;
    const prevPerfs = prev.performances ?? null;
    const perShowPct = perfs && prevPerfs && perfs !== prevPerfs ? pctChange(row.gross / perfs, prev.gross / prevPerfs, 0) : null;
    if (!isScheduleMove(pct, prevPerfs, perShowPct)) continue;
    all.push({ slug, gross: row.gross, prevGross: prev.gross, pct, performances: perfs, prevPerformances: prevPerfs, perShowPct, capacity: row.capacity ?? null });
  }
  const gains = all.filter((m) => m.pct >= MOVER_MIN_PCT).sort((a, b) => b.pct - a.pct || a.slug.localeCompare(b.slug)).slice(0, n);
  const drops = all.filter((m) => m.pct <= -MOVER_MIN_PCT).sort((a, b) => a.pct - b.pct || a.slug.localeCompare(b.slug)).slice(0, n);
  return { gains, drops };
}

// ------------------------------------------------------------------
// Gross per seat
// ------------------------------------------------------------------

export interface PerSeatRow {
  slug: string;
  /** Gross per seat offered over the last 4 reported weeks (paired rows only). */
  perSeat: number;
  /** This week's rank by gross among reporting Broadway shows (1-based). */
  grossRank: number;
  /** Seats per performance (the house size) from the latest paired week. */
  seats: number | null;
  /** Reported weeks behind the figure (under 4 = too new to rank). */
  weeksUsed: number;
}

export function perSeatTable(input: MarketInput, week: string): { ranked: PerSeatRow[]; tooNew: PerSeatRow[]; reporting: number } {
  const now = marketWeek(input, week);
  if (!now) return { ranked: [], tooNew: [], reporting: 0 };
  const ranked: PerSeatRow[] = [];
  const tooNew: PerSeatRow[] = [];
  now.ranked.forEach(({ slug }, i) => {
    const rows = lastReportedWeeks(rowFor(input, slug), week);
    const perSeat = grossPerSeat(rows);
    if (perSeat == null) return;
    const latest = rows.find(isPaired);
    const seats = latest && latest.performances ? Math.round(latest.seatsOffered! / latest.performances) : null;
    const weeksUsed = rows.filter(isPaired).length;
    const r = { slug, perSeat, grossRank: i + 1, seats, weeksUsed };
    (weeksUsed >= TRAILING_WEEKS ? ranked : tooNew).push(r);
  });
  ranked.sort((a, b) => b.perSeat - a.perSeat || a.slug.localeCompare(b.slug));
  tooNew.sort((a, b) => b.perSeat - a.perSeat || a.slug.localeCompare(b.slug));
  return { ranked, tooNew, reporting: now.shows };
}

// ------------------------------------------------------------------
// Standouts
// ------------------------------------------------------------------

/** Capacity is a percent in the history (max about 106). */
export const SELL_OUT_CAPACITY = 95;
/** Unreported weeks a streak may pass over (a holiday dark week), never the COVID gap. */
const STREAK_MAX_SKIP = 2;

/** Straight reported weeks at 95% full or more, ending this week; 0 when this week is under. */
export function sellOutStreak(row: (week: string) => HistoryRow | null | undefined, week: string): number {
  let streak = 0;
  let skipped = 0;
  for (let w = week; w >= HISTORY_START; w = addDays(w, -7)) {
    const r = row(w);
    if (!isReported(r)) {
      if (streak === 0 || ++skipped > STREAK_MAX_SKIP) break;
      continue;
    }
    if (r.capacity == null || r.capacity < SELL_OUT_CAPACITY) break;
    skipped = 0;
    streak++;
  }
  return streak;
}

export function sellOutStreaks(input: MarketInput, week: string, min = 2): Array<{ slug: string; weeks: number }> {
  const out = [];
  for (const slug of Object.keys(input.weeks[week] ?? {})) {
    if (!isBroadwaySlug(input, slug)) continue;
    const weeks = sellOutStreak(rowFor(input, slug), week);
    if (weeks >= min) out.push({ slug, weeks });
  }
  return out.sort((a, b) => b.weeks - a.weeks || a.slug.localeCompare(b.slug));
}

/** Average ticket above this week's Broadway median; `isNew` = under 4 reported weeks. */
export function premiumPull(input: MarketInput, week: string): { median: number | null; above: Array<{ slug: string; atp: number; over: number; isNew: boolean }> } {
  const atps: Array<{ slug: string; atp: number }> = [];
  for (const [slug, row] of Object.entries(input.weeks[week] ?? {})) {
    if (!isReported(row) || !isBroadwaySlug(input, slug) || !(row.atp && row.atp > 0)) continue;
    atps.push({ slug, atp: row.atp });
  }
  const mid = median(atps.map((a) => a.atp));
  if (mid == null) return { median: null, above: [] };
  const above = atps
    .filter((a) => a.atp > mid)
    .map((a) => ({ ...a, over: a.atp - mid, isNew: lastReportedWeeks(rowFor(input, a.slug), week).length < TRAILING_WEEKS }))
    .sort((a, b) => b.over - a.over || a.slug.localeCompare(b.slug));
  return { median: mid, above };
}

// ------------------------------------------------------------------
// Runs by week since first preview
// ------------------------------------------------------------------

/** The first week ending on or after a date (weeks end on Sunday). */
export function weekEndingOnOrAfter(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, (7 - dow) % 7);
}

/** 1-based week of a run, counting from the week of its first preview. */
export function weekOfRun(firstPreview: string, week: string): number {
  return Math.floor(daysBetween(weekEndingOnOrAfter(firstPreview), week) / 7) + 1;
}

/**
 * A run that can be compared week by week from its first preview: a
 * Broadway play or musical whose first preview falls inside the history.
 * Shows without a previews date are left out, never guessed.
 */
export function isComparableRun(show: MarketShow): boolean {
  return show.category === 'broadway'
    && (show.type === 'musical' || show.type === 'play')
    && !!show.previewsStartDate
    && show.previewsStartDate >= HISTORY_START;
}

/** Gross per seat by week of run (index i = week i+1), paired rows only; null where unpaired. */
export function runPerSeatSeries(input: MarketInput, show: MarketShow, maxWeeks: number, throughWeek?: string): Array<number | null> {
  const first = weekEndingOnOrAfter(show.previewsStartDate!);
  const out: Array<number | null> = [];
  for (let i = 0; i < maxWeeks; i++) {
    const week = addDays(first, 7 * i);
    if (throughWeek && week > throughWeek) break;
    const r = input.weeks[week]?.[show.slug];
    out.push(isPaired(r) ? r.gross / r.seatsOffered : null);
  }
  return out;
}

/** New-musical cohort chart starts at this week of a run. */
export const PACE_MIN_WEEK = 4;

/** Cohort window: new musicals from this many years before the latest week (2016 for a 2026 week). */
export const COHORT_YEARS = 10;
/** Below this many musicals at a week, the shaded middle half is not drawn. */
export const COHORT_MIN_N = 15;

export interface CohortBand {
  /** New (non-revival) musicals whose first preview is in the window and that have a paired week. */
  musicals: number;
  fromYear: number;
  /** Index i = week i+1: p25 / median / p75 of gross per seat, null where n < 15. */
  band: Array<{ p25: number; median: number; p75: number; n: number } | null>;
}

/** The middle half of new musicals' gross per seat, week by week from first preview. Revivals are left out. */
export function newMusicalCohort(input: MarketInput, latestWeek: string, maxWeeks: number): CohortBand {
  const fromYear = Number(latestWeek.slice(0, 4)) - COHORT_YEARS;
  const series = Array.from(input.shows.values())
    .filter((s) => isComparableRun(s) && s.type === 'musical' && !s.isRevival && Number(s.previewsStartDate!.slice(0, 4)) >= fromYear)
    .map((s) => runPerSeatSeries(input, s, maxWeeks, latestWeek))
    .filter((ser) => ser.some((x) => x != null));
  const band: CohortBand['band'] = [];
  for (let i = 0; i < maxWeeks; i++) {
    const v = series.map((s) => s[i]).filter((x): x is number => x != null);
    band.push(v.length >= COHORT_MIN_N ? { p25: quantile(v, 0.25)!, median: quantile(v, 0.5)!, p75: quantile(v, 0.75)!, n: v.length } : null);
  }
  return { musicals: series.length, fromYear, band };
}

// ------------------------------------------------------------------
// One show's week, for the Box Office Scorecard on its page
// ------------------------------------------------------------------

export const FACTS_CHART_WEEKS = 52;
/** A run of weeks counts as "held between" while its highest gross is within 30% of its lowest. */
export const STEADY_MAX_RATIO = 1.3;
export const STEADY_MIN_WEEKS = 8;

export interface ShowFacts {
  /** The show's latest reported week (earlier than the market's for a closed show). */
  week: string;
  /** False when the show has no row in the latest week (closed, or dark that week). */
  current: boolean;
  gross: number;
  rank: number;
  of: number;
  yearAgoPct: number | null;
  /** All of Broadway, same two weeks; null when either week is partial. */
  marketYearAgoPct: number | null;
  /** The year-ago change split into tickets sold and average ticket price; null without both weeks' attendance. */
  attendanceYoyPct: number | null;
  atpYoyPct: number | null;
  /** All of Broadway's attendance, same two weeks as marketYearAgoPct. */
  marketAttendanceYoyPct: number | null;
  /** Oldest first, from the show's first reported week in the last 52; unreported weeks are null. */
  series: Array<{ week: string; gross: number | null }>;
  /** The latest stretch of weeks that stayed within STEADY_MAX_RATIO, when at least STEADY_MIN_WEEKS long. */
  steady: { low: number; high: number; since: string } | null;
  /** This run's records (personalBests), null under BESTS_MIN_WEEKS. */
  bests: PersonalBests | null;
}

function avgTicket(r: HistoryRow): number | null {
  if (r.atp != null && r.atp > 0) return r.atp;
  return r.gross != null && r.attendance ? r.gross / r.attendance : null;
}

/** Tickets sold across a market week's reporting shows; null when any of them lacks attendance. */
function weekAttendance(input: MarketInput, w: MarketWeek): number | null {
  let total = 0;
  for (const { slug } of w.ranked) {
    const a = input.weeks[w.week]?.[slug]?.attendance;
    if (a == null) return null;
    total += a;
  }
  return total;
}

export function showFacts(input: MarketInput, slug: string, latestWeek: string): ShowFacts | null {
  const row = rowFor(input, slug);
  let week: string | null = null;
  // A closed show's card describes its last reported week; look back at most a year.
  for (let w = latestWeek, i = 0; i < FACTS_CHART_WEEKS; w = addDays(w, -7), i++) {
    if (isReported(row(w))) { week = w; break; }
  }
  if (!week) return null;
  const gross = (row(week) as HistoryRow).gross as number;
  const market = marketWeek(input, week);
  const rank = market ? market.ranked.findIndex((r) => r.slug === slug) + 1 : 0;

  const lyShow = yearAgoWeek((w) => isFullWeek(row(w)), week);
  const yearAgoPct = lyShow ? pctChange(gross, row(lyShow)?.gross) : null;
  const lyMarket = market ? comparableTotal(input, yearAgoWeek((w) => !!input.weeks[w], week), market.shows) : null;
  const marketYearAgoPct = market && lyMarket ? pctChange(market.gross, lyMarket.gross) : null;
  const now = row(week) as HistoryRow;
  const ly = lyShow ? row(lyShow) : undefined;
  const attendanceYoyPct = pctChange(now.attendance, ly?.attendance, 1);
  const atpYoyPct = attendanceYoyPct == null ? null : pctChange(avgTicket(now), ly ? avgTicket(ly) : null, 1);
  const marketAttendanceYoyPct = market && lyMarket ? pctChange(weekAttendance(input, market), weekAttendance(input, lyMarket), 1) : null;

  const series: ShowFacts['series'] = [];
  for (let i = FACTS_CHART_WEEKS - 1; i >= 0; i--) {
    const w = addDays(week, -7 * i);
    const r = row(w);
    series.push({ week: w, gross: isReported(r) ? ((r as HistoryRow).gross as number) : null });
  }
  const first = series.findIndex((p) => p.gross != null);

  let low = Infinity;
  let high = -Infinity;
  let n = 0;
  let since = week;
  for (let i = series.length - 1; i >= 0; i--) {
    const g = series[i].gross;
    if (g == null) break;
    const lo = Math.min(low, g);
    const hi = Math.max(high, g);
    if (hi > lo * STEADY_MAX_RATIO) break;
    low = lo;
    high = hi;
    n++;
    since = series[i].week;
  }
  const steady = n >= STEADY_MIN_WEEKS ? { low, high, since } : null;

  return { week, current: week === latestWeek, gross, rank, of: market?.shows ?? 0, yearAgoPct, marketYearAgoPct, attendanceYoyPct, atpYoyPct, marketAttendanceYoyPct, series: series.slice(Math.max(0, first)), steady, bests: personalBests(input, slug, week) };
}

// ------------------------------------------------------------------
// Personal bests: this run's records, Broadway League figures only
// ------------------------------------------------------------------

/** A run needs at least this many reported weeks before its records mean anything. */
export const BESTS_MIN_WEEKS = 4;
/** A silence longer than this (not counting the COVID shutdown) ends one engagement; earlier weeks belong to another. */
export const BESTS_MAX_GAP_WEEKS = 26;
/** Without a first-preview date, the run is taken to start this many weeks before opening night. */
const BESTS_PREVIEW_WEEKS = 8;
/** Below this attendance a gross/attendance average ticket is noise, not a record. */
const BESTS_MIN_ATTENDANCE = 100;

/** Weeks between two week endings, less any part of the COVID shutdown between them. */
function gapWeeks(from: string, to: string): number {
  const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  let d = days(from, to);
  const lo = from > SHUTDOWN_START ? from : SHUTDOWN_START;
  const hi = to < SHUTDOWN_END ? to : SHUTDOWN_END;
  if (hi > lo) d -= days(lo, hi);
  return d / 7;
}

export type BestKey = 'gross' | 'capacity' | 'atp';

export interface BestRow {
  key: BestKey;
  /** The record and the week it was set; the earliest week wins a tie. */
  value: number;
  week: string;
  /** The same measure in the show's latest reported week; null when that week lacks it. */
  latest: number | null;
  /** The latest week set the record. */
  latestIsRecord: boolean;
}

export interface PersonalBests {
  /** The show's latest reported week, which `latest` describes. */
  latestWeek: string;
  weeks: number;
  rows: BestRow[];
}

/**
 * A production's own reported weeks up to `latestWeek`, oldest first. History
 * is keyed by production, so a revival never inherits the original run's
 * weeks. Two guards catch rows filed under the wrong production anyway: rows
 * before the run's first preview week (or BESTS_PREVIEW_WEEKS before opening
 * when the preview date is unknown) are skipped, and only the weeks after the
 * last silence longer than BESTS_MAX_GAP_WEEKS (shutdown excluded) count.
 * Partial preview weeks count, including the older rows that list preview
 * weeks with 0 performances but a real gross (the zero-perf-gross integrity
 * rule), so any week with a gross is a week of the run here. Shared by
 * personalBests and weeklyRecords.
 */
export function ownRunWeeks(input: MarketInput, slug: string, latestWeek: string): string[] {
  const row = rowFor(input, slug);
  const show = input.shows.get(slug);
  const first = show?.previewsStartDate ?? (show?.openingDate ? addDays(show.openingDate, -7 * BESTS_PREVIEW_WEEKS) : null);
  const start = first ? weekEndingOnOrAfter(first) : null;
  const weeks = Object.keys(input.weeks)
    .filter((w) => w <= latestWeek && (!start || w >= start) && isReported(row(w)))
    .sort();
  for (let i = weeks.length - 1; i > 0; i--) {
    if (gapWeeks(weeks[i - 1], weeks[i]) > BESTS_MAX_GAP_WEEKS) return weeks.slice(i);
  }
  return weeks;
}

/**
 * This run's best week, fullest week and highest average ticket over
 * ownRunWeeks. A week missing capacity or attendance is left out of that
 * measure (never read as 0). Null with fewer than BESTS_MIN_WEEKS weeks.
 */
export function personalBests(input: MarketInput, slug: string, latestWeek: string): PersonalBests | null {
  const row = rowFor(input, slug);
  const weeks = ownRunWeeks(input, slug, latestWeek);
  if (weeks.length < BESTS_MIN_WEEKS) return null;
  const last = weeks[weeks.length - 1];
  const measures: Array<[BestKey, (r: HistoryRow) => number | null]> = [
    ['gross', (r) => r.gross ?? null],
    ['capacity', (r) => (r.capacity != null && r.capacity > 0 ? r.capacity : null)],
    ['atp', (r) => (r.atp != null && r.atp > 0 ? r.atp : r.gross != null && (r.attendance ?? 0) >= BESTS_MIN_ATTENDANCE ? r.gross / (r.attendance as number) : null)],
  ];
  const rows: BestRow[] = [];
  for (const [key, of] of measures) {
    let best: { value: number; week: string } | null = null;
    for (const w of weeks) {
      const v = of(row(w) as HistoryRow);
      if (v != null && (!best || v > best.value)) best = { value: v, week: w };
    }
    if (best) rows.push({ key, value: best.value, week: best.week, latest: of(row(last) as HistoryRow), latestIsRecord: best.week === last });
  }
  return { latestWeek: last, weeks: weeks.length, rows };
}

/** A latest week must top at least this many of the run's weeks before it to count as a record. */
export const RECORD_MIN_PRIOR_WEEKS = 8;

export interface WeeklyRecord {
  slug: string;
  /** The latest week topped every earlier week of the run. */
  ever: boolean;
  /** The last earlier week that grossed as much or more; null when `ever`. */
  since: string | null;
  /** Earlier weeks it topped in a row (the whole run when `ever`). */
  topped: number;
}

/**
 * Shows whose gross in `week` is their best in a long time, judged only
 * against their own run (ownRunWeeks): it must beat each of at least
 * RECORD_MIN_PRIOR_WEEKS weeks just before it. A tie is not a record.
 * Run-long records first, then the ones reaching furthest back.
 */
export function weeklyRecords(input: MarketInput, week: string): WeeklyRecord[] {
  const out: WeeklyRecord[] = [];
  for (const [slug, r] of Object.entries(input.weeks[week] ?? {})) {
    if (!isReported(r) || !isBroadwaySlug(input, slug)) continue;
    const weeks = ownRunWeeks(input, slug, week);
    if (weeks[weeks.length - 1] !== week) continue;
    const prior = weeks.slice(0, -1);
    if (prior.length < RECORD_MIN_PRIOR_WEEKS) continue;
    const row = rowFor(input, slug);
    let i = prior.length - 1;
    while (i >= 0 && ((row(prior[i]) as HistoryRow).gross as number) < r.gross) i--;
    const topped = prior.length - 1 - i;
    if (topped < RECORD_MIN_PRIOR_WEEKS) continue;
    out.push({ slug, ever: i < 0, since: i < 0 ? null : prior[i], topped });
  }
  return out.sort((a, b) => Number(b.ever) - Number(a.ever) || (a.since ?? '').localeCompare(b.since ?? '') || b.topped - a.topped || a.slug.localeCompare(b.slug));
}
