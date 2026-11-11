/**
 * Opening-night "reviews still arriving" status (BRO-7376, design-only).
 *
 * The hero already covers two other states: below the score minimum ("Awaiting
 * reviews", ShowHeroRedesign AwaitingCard) and no reviews ever expected
 * (review-expectation.ts). Nothing told a reader that a score showing on
 * opening night is early and still moving. This is the pure decision layer for
 * that status. Every input is passed in; the page computes it once on the
 * server and hands the result down (the page is ISR-cached, so a client-side
 * clock could disagree with the server HTML).
 *
 * Where the numbers come from (never invented):
 *  - "about N expected": the median count of reviews that were live within
 *    ARRIVAL_WINDOW_HOURS of press night for the previous HISTORY_SIZE Broadway
 *    openings (reviews.json publish dates). scripts/review-arrival-accuracy.ts
 *    reports how far off that was on the last 10 openings.
 *  - "regular outlets in / still to come": data/outlet-registry.json
 *    standingCoverage, the set of outlets that review nearly every Broadway
 *    opening (scripts/lib/standing-outlets.js). Hit rate is measured there.
 *  - the window length: 72h, the same bar expected-critics.js (BRO-7166) uses
 *    for "a standing outlet with no review 72h after opening is a gap".
 *
 * Broadway only for now: the history that backs the count exists for Broadway.
 */

export const ARRIVAL_WINDOW_HOURS = 72;
export const HISTORY_SIZE = 10;
/** nearly-complete once this share of the expected count is in */
export const NEARLY_COMPLETE_RATIO = 0.8;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// Press-night reviews drop about 10pm Eastern on the opening date, which is
// 02:00Z (EDT) or 03:00Z (EST) the next UTC day. Use the later one so the
// window never closes early.
const EMBARGO_OFFSET_MS = DAY_MS + 3 * HOUR_MS;
// The status appears on the afternoon of opening day, before the embargo, so
// "opening night, reviews expected tonight" can show.
const START_OFFSET_MS = 12 * HOUR_MS;

export type ArrivalPhase = 'waiting' | 'below-minimum' | 'early' | 'nearly-complete';

export interface HistoryShow {
  id: string;
  category?: string | null;
  openingDate?: string | null;
  /** publish dates (YYYY-MM-DD or null) of every review on file */
  reviewDates: Array<string | null | undefined>;
}

export interface ExpectedCount {
  /** median, rounded to the nearest 5 for display ("about 30") */
  expected: number;
  /** unrounded median */
  median: number;
  low: number;
  high: number;
  /** how many past openings it is built from */
  n: number;
}

function dateMs(d: string | null | undefined): number | null {
  if (!d) return null;
  const ms = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** When press-night reviews are released (approx), epoch ms. */
export function pressNightEmbargoMs(openingDate: string | null | undefined): number | null {
  const ms = dateMs(openingDate);
  return ms == null ? null : ms + EMBARGO_OFFSET_MS;
}

/** When the status stops showing, epoch ms. */
export function arrivalWindowEndMs(openingDate: string | null | undefined): number | null {
  const e = pressNightEmbargoMs(openingDate);
  return e == null ? null : e + ARRIVAL_WINDOW_HOURS * HOUR_MS;
}

/**
 * Reviews counted as "part of the opening wave": published no later than the
 * end of the arrival window (publish dates are date-only, so the cutoff is the
 * date 3 days after press night). A review with no date counts, since nothing
 * says it came later.
 */
export function windowCount(reviewDates: Array<string | null | undefined>, openingDate: string | null | undefined): number {
  const open = dateMs(openingDate);
  if (open == null) return reviewDates.length;
  const cutoff = open + (ARRIVAL_WINDOW_HOURS / 24) * DAY_MS;
  return reviewDates.filter((d) => {
    const ms = dateMs(d);
    return ms == null || ms <= cutoff;
  }).length;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Median (and quartiles) of the opening-wave counts of past openings. null with no history. */
export function expectedFromCounts(counts: number[]): ExpectedCount | null {
  const c = counts.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (c.length === 0) return null;
  const mid = c.length % 2 ? c[(c.length - 1) / 2] : (c[c.length / 2 - 1] + c[c.length / 2]) / 2;
  return {
    expected: Math.max(5, Math.round(mid / 5) * 5),
    median: mid,
    low: quantile(c, 0.25),
    high: quantile(c, 0.75),
    n: c.length,
  };
}

/**
 * Expected count for a show: the previous HISTORY_SIZE Broadway openings (same
 * category, opened strictly before this one, with at least one review).
 */
export function expectedForShow(
  show: { id: string; category?: string | null; openingDate?: string | null },
  history: HistoryShow[],
): ExpectedCount | null {
  const open = dateMs(show.openingDate);
  if (open == null || (show.category && show.category !== 'broadway')) return null;
  const prior = history
    .filter((h) => h.id !== show.id && h.category === 'broadway' && h.reviewDates.length > 0)
    .map((h) => ({ h, ms: dateMs(h.openingDate) }))
    .filter((x): x is { h: HistoryShow; ms: number } => x.ms != null && x.ms < open)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, HISTORY_SIZE);
  return expectedFromCounts(prior.map(({ h }) => windowCount(h.reviewDates, h.openingDate)));
}

export interface ArrivalInput {
  now: Date;
  openingDate?: string | null;
  category?: string | null;
  reviewCount: number;
  /** true when the page is showing a CriticScore (not the "Awaiting reviews" card) */
  scoreShowing: boolean;
  expected: ExpectedCount | null;
}

/**
 * Which state the status is in, or null when it should not show (not Broadway,
 * not yet opening day, or the window has closed).
 */
export function reviewArrivalPhase(i: ArrivalInput): ArrivalPhase | null {
  if (i.category && i.category !== 'broadway') return null;
  const open = dateMs(i.openingDate);
  const end = arrivalWindowEndMs(i.openingDate);
  if (open == null || end == null || !i.expected) return null;
  const t = i.now.getTime();
  if (t < open + START_OFFSET_MS || t > end) return null;
  if (i.reviewCount <= 0) return 'waiting';
  if (!i.scoreShowing) return 'below-minimum';
  return i.reviewCount / i.expected.expected >= NEARLY_COMPLETE_RATIO ? 'nearly-complete' : 'early';
}

export interface OutletRef {
  id: string;
  name: string;
}

/** Split the regular outlets into those with a review on file and those still to come. */
export function splitRegularOutlets(
  regular: OutletRef[],
  haveOutletIds: Iterable<string>,
): { inNow: OutletRef[]; stillToCome: OutletRef[] } {
  const have = new Set(Array.from(haveOutletIds, (s) => String(s).toLowerCase()));
  const inNow: OutletRef[] = [];
  const stillToCome: OutletRef[] = [];
  for (const o of regular) (have.has(o.id.toLowerCase()) ? inNow : stillToCome).push(o);
  return { inNow, stillToCome };
}

export interface ReviewArrival {
  phase: ArrivalPhase;
  reviewCount: number;
  /** rounded "about" number */
  expected: number;
  /** quartile range of the history it came from */
  range: [number, number];
  historyN: number;
  /** ISO time the newest counted review went live, when known */
  updatedAt: string | null;
  /** hours since press-night embargo (negative before it) */
  hoursSinceEmbargo: number;
  /** hours left in the window */
  hoursLeft: number;
  regularIn: OutletRef[];
  regularToCome: OutletRef[];
}

/** One call for the page: decide the phase and assemble the props the hero renders. */
export function buildReviewArrival(
  i: ArrivalInput & {
    updatedAt?: string | null;
    regular?: OutletRef[];
    haveOutletIds?: Iterable<string>;
  },
): ReviewArrival | null {
  const phase = reviewArrivalPhase(i);
  if (!phase || !i.expected) return null;
  const embargo = pressNightEmbargoMs(i.openingDate)!;
  const end = arrivalWindowEndMs(i.openingDate)!;
  const split = splitRegularOutlets(i.regular ?? [], i.haveOutletIds ?? []);
  return {
    phase,
    reviewCount: i.reviewCount,
    expected: i.expected.expected,
    range: [i.expected.low, i.expected.high],
    historyN: i.expected.n,
    updatedAt: i.updatedAt ?? null,
    hoursSinceEmbargo: (i.now.getTime() - embargo) / HOUR_MS,
    hoursLeft: Math.max(0, (end - i.now.getTime()) / HOUR_MS),
    regularIn: split.inNow,
    regularToCome: split.stillToCome,
  };
}

/** The one status line shown with the Critic Score (owner wording, BRO-7376). */
export function arrivalText(a: Pick<ReviewArrival, 'phase' | 'reviewCount' | 'expected'>): string {
  const n = a.reviewCount;
  if (a.phase === 'waiting') return `No reviews yet, expect ~${a.expected} total`;
  const noun = n === 1 ? 'review' : 'reviews';
  if (n >= a.expected) return `${n} ${noun} so far, a few more may land`;
  return `${n} ${noun} so far, more coming in, expect ~${a.expected} total`;
}
