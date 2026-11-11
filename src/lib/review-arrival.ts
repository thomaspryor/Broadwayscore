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
 *  - "expect LOW to HIGH": a range for the morning-after count. For each of the
 *    previous HISTORY_SIZE Broadway openings, how many reviews were in by 9am ET
 *    the morning after (see morningCount); LOW is the 25th percentile of those
 *    rounded down to 5, HIGH the 75th rounded up to 5 (owner, BRO-7376 round 3).
 *    The line ends when the count reaches LOW, so it never promises more than
 *    usually shows up. scripts/review-arrival-accuracy.ts reports how often past
 *    openings landed inside, below and above it.
 *  - "regular outlets in / still to come": data/outlet-registry.json
 *    standingCoverage, the set of outlets that review nearly every Broadway
 *    opening (scripts/lib/standing-outlets.js). Hit rate is measured there.
 *  - the window length: 72h, the same bar expected-critics.js (BRO-7166) uses
 *    for "a standing outlet with no review 72h after opening is a gap".
 *
 * Broadway only for now: the history that backs the count exists for Broadway.
 */

export const HISTORY_SIZE = 10;
/** The status ends at this Eastern hour the morning after opening, if the count has not reached the estimate first. */
export const ARRIVAL_END_ET_HOUR = 9;
/**
 * reviews.json publish dates are date-only, so "in by 9am ET the morning after"
 * is estimated as this share of the reviews dated opening day or the next day.
 * Measured on the 4 Broadway openings that have real go-live timestamps
 * (data/audit/press-night): 0.85, 0.95, 0.79, 0.87, mean 0.865.
 */
export const MORNING_SHARE = 0.865;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// Press-night reviews drop about 10pm Eastern on the opening date, which is
// 02:00Z (EDT) or 03:00Z (EST) the next UTC day. Use the later one.
const EMBARGO_OFFSET_MS = DAY_MS + 3 * HOUR_MS;
// The status appears on the afternoon of opening day, before the embargo, so
// "opening night, reviews expected tonight" can show.
const START_OFFSET_MS = 12 * HOUR_MS;

export type ArrivalPhase = 'waiting' | 'below-minimum' | 'early';

export interface HistoryShow {
  id: string;
  category?: string | null;
  openingDate?: string | null;
  /** publish dates (YYYY-MM-DD or null) of every review on file */
  reviewDates: Array<string | null | undefined>;
}

export interface ExpectedCount {
  /** low end of the range: 25th percentile of the morning-after counts, rounded DOWN to 5. The line ends at this count. */
  expected: number;
  /** high end: 75th percentile, rounded UP to 5 */
  expectedHigh: number;
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

/** 9am Eastern the morning after opening (DST-aware), epoch ms. The status ends here at the latest. */
export function arrivalWindowEndMs(openingDate: string | null | undefined): number | null {
  const ms = dateMs(openingDate);
  if (ms == null) return null;
  const guess = ms + DAY_MS + 13 * HOUR_MS; // 9am EDT
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(guess)));
  return etHour === ARRIVAL_END_ET_HOUR ? guess : guess + HOUR_MS; // 9am EST is 14:00Z
}

/**
 * Reviews in by 9am ET the morning after opening, estimated from date-only
 * publish dates: MORNING_SHARE of those dated opening day or the next day.
 */
export function morningCount(reviewDates: Array<string | null | undefined>, openingDate: string | null | undefined): number {
  const open = dateMs(openingDate);
  if (open == null) return 0;
  const n = reviewDates.filter((d) => {
    const ms = dateMs(d);
    return ms != null && ms >= open && ms <= open + DAY_MS;
  }).length;
  return Math.round(n * MORNING_SHARE);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Conservative estimate (25th percentile, rounded down to 5) from past morning-after counts. null with no history. */
export function expectedFromCounts(counts: number[]): ExpectedCount | null {
  const c = counts.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (c.length === 0) return null;
  const mid = c.length % 2 ? c[(c.length - 1) / 2] : (c[c.length / 2 - 1] + c[c.length / 2]) / 2;
  return {
    expected: Math.max(5, Math.floor(quantile(c, 0.25) / 5) * 5),
    expectedHigh: Math.max(5, Math.ceil(quantile(c, 0.75) / 5) * 5),
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
  return expectedFromCounts(prior.map(({ h }) => morningCount(h.reviewDates, h.openingDate)));
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
  // Done: the count reached the estimate, so nothing implies more are owed.
  if (i.reviewCount >= i.expected.expected) return null;
  if (i.reviewCount <= 0) return 'waiting';
  if (!i.scoreShowing) return 'below-minimum';
  return 'early';
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
  /** low end of the expected range (the line ends when the count reaches it) */
  expected: number;
  expectedHigh: number;
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
    expectedHigh: i.expected.expectedHigh,
    range: [i.expected.low, i.expected.high],
    historyN: i.expected.n,
    updatedAt: i.updatedAt ?? null,
    hoursSinceEmbargo: (i.now.getTime() - embargo) / HOUR_MS,
    hoursLeft: Math.max(0, (end - i.now.getTime()) / HOUR_MS),
    regularIn: split.inNow,
    regularToCome: split.stillToCome,
  };
}

/** The one status line shown with the Critic Score (owner wording, BRO-7376 round 3). */
export function arrivalText(a: Pick<ReviewArrival, 'phase' | 'reviewCount' | 'expected' | 'expectedHigh'>): string {
  const n = a.reviewCount;
  const range = a.expectedHigh > a.expected ? `${a.expected} to ${a.expectedHigh}` : `about ${a.expected}`;
  if (a.phase === 'waiting') return `Reviews tonight, expect ${range}`;
  return `${n} ${n === 1 ? 'review' : 'reviews'} so far, expect ${range}`;
}
