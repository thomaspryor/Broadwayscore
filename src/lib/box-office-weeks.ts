// Week arithmetic for the Box Office / Commercial v3 sections (BRO-5007).
// Pure: no data imports, so tests require the real functions and the client
// never pulls history in. One definition each for the year-ago week, the
// season and the trailing window; every v3 number goes through these.

/** One show's row in one week of grosses-history.json. */
export interface HistoryRow {
  gross: number | null;
  capacity?: number | null;
  atp?: number | null;
  attendance?: number | null;
  seatsOffered?: number | null;
  performances?: number | null;
}

/** grosses-history.json `weeks`: week ending (YYYY-MM-DD, a Sunday) → production slug → row. */
export type HistoryWeeks = Record<string, Record<string, HistoryRow>>;

const DAY_MS = 86_400_000;

export function addDays(week: string, days: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Nearest YoY tolerance: the League week a year back is exactly 364 days earlier. */
export const YOY_MAX_DAYS = 7;

/**
 * The week a year before `week`: exactly 364 days earlier when stored, else
 * the nearest stored week within ±7 days of it, else null (never a throw,
 * never a guess further off).
 */
export function yearAgoWeek(hasWeek: (w: string) => boolean, week: string, maxDays = YOY_MAX_DAYS): string | null {
  const target = addDays(week, -364);
  if (hasWeek(target)) return target;
  for (let d = 1; d <= maxDays; d++) {
    for (const w of [addDays(target, -d), addDays(target, d)]) if (hasWeek(w)) return w;
  }
  return null;
}

/** Below this denominator a percent change is noise (a show's first partial week, a dark week). */
export const MIN_PCT_DENOMINATOR = 10_000;

/** Percent change, null when either side is missing or the base is under $10K. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined, minDenom = MIN_PCT_DENOMINATOR): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (Math.abs(prev) < minDenom) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Broadway season of a week ending, the same July 1 to June 30 rule /biz uses
 * (getSeason). Read from the date string itself: getSeason works in local
 * time, which moves a June 30 week ending into July east of UTC+12.
 */
export function seasonOfWeek(week: string): string {
  const y = Number(week.slice(0, 4));
  return Number(week.slice(5, 7)) >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** First week ending (Sunday) on or after July 1 of the season's start year. */
export function seasonFirstWeek(season: string): string {
  const startYear = Number(season.slice(0, 4));
  const july1 = `${startYear}-07-01`;
  const dow = new Date(`${july1}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(july1, (7 - dow) % 7);
}

/**
 * 1-based week of the season. Seasons hold 52 or 53 week endings; comparing
 * "season so far" by this index lines a 53-week season up with a 52-week one.
 */
export function weekOfSeason(week: string): number {
  return Math.floor(daysBetween(seasonFirstWeek(seasonOfWeek(week)), week) / 7) + 1;
}

/** The season `n` seasons before (n=1: last season). */
export function priorSeason(season: string, n = 1): string {
  const y = Number(season.slice(0, 4)) - n;
  return `${y}-${y + 1}`;
}

/**
 * A week counts as reported when it has a positive gross. A dark week has no
 * gross (0 or null). Performances do not decide it: 2,600+ history rows
 * (97% in a run's first 6 weeks, still arriving for new shows in 2026; the
 * zero-perf-gross integrity rule) list 0 performances beside a real gross
 * because the source dropped the Previews column, and
 * grosses-history-repair.js can only fill the provable ones (BRO-5057).
 * Treat a listed 0 as an unknown count wherever performances matter.
 */
export function isReported(r: HistoryRow | null | undefined): r is HistoryRow & { gross: number } {
  return !!r && typeof r.gross === 'number' && r.gross > 0;
}

/** Usable for per-seat and price maths: gross AND seatsOffered both present and positive. */
export function isPaired(r: HistoryRow | null | undefined): r is HistoryRow & { gross: number; seatsOffered: number } {
  return isReported(r) && typeof r.seatsOffered === 'number' && r.seatsOffered > 0;
}

export const TRAILING_WEEKS = 4;
/** How far back "the last 4 reported weeks" may reach; keeps the COVID gap from joining 2020 to 2021. */
export const TRAILING_LOOKBACK_WEEKS = 8;

export interface DatedRow extends HistoryRow {
  week: string;
}

/**
 * A show's last `n` reported weeks ending at `endWeek`: dark or unreported
 * weeks are skipped (not counted as zero) but the window never reaches more
 * than `lookbackWeeks` calendar weeks back. Newest first.
 */
export function lastReportedWeeks(
  rowFor: (week: string) => HistoryRow | null | undefined,
  endWeek: string,
  n = TRAILING_WEEKS,
  lookbackWeeks = TRAILING_LOOKBACK_WEEKS,
): DatedRow[] {
  const out: DatedRow[] = [];
  for (let i = 0; i < lookbackWeeks && out.length < n; i++) {
    const week = addDays(endWeek, -7 * i);
    const r = rowFor(week);
    if (isReported(r)) out.push({ ...r, week });
  }
  return out;
}

/** sum(gross) / sum(seatsOffered) over paired rows only; null when none. */
export function grossPerSeat(rows: HistoryRow[]): number | null {
  let gross = 0;
  let seats = 0;
  for (const r of rows) {
    if (!isPaired(r)) continue;
    gross += r.gross;
    seats += r.seatsOffered;
  }
  return seats > 0 ? gross / seats : null;
}

/** Median of the values, null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated quantile (q in 0..1) of the values, null when empty. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** A week with fewer performances than this is partial (first previews, a dark stretch). */
export const MIN_FULL_WEEK_PERFORMANCES = 6;

/**
 * A reported week that is not partial, so it can be a year-ago base. A row
 * listing 0 performances with a gross has an unknown count (see isReported),
 * so it is never a full week.
 */
export function isFullWeek(r: HistoryRow | undefined | null): r is HistoryRow {
  return isReported(r) && (r.performances == null || r.performances >= MIN_FULL_WEEK_PERFORMANCES);
}
