/**
 * Closing Watch (BRO-7246): running Broadway shows that have not announced a
 * closing but whose grosses trail break-even, with our estimate of when they
 * are likely to close.
 *
 * The estimate is an extrapolation, marked as ours on the page. How it works:
 *
 * 1. Each week's 4-week average gross is divided by break-even and by a
 *    seasonal index (the market's 4-week average per show over its own
 *    52-week average), so the January slump does not read as a show failing.
 * 2. A "spell" starts the week that adjusted ratio falls under a threshold
 *    (100%, 90%, 75% or 60% of break-even). Every spell of every Broadway
 *    show we have a break-even for is one observation: weeks from the spell's
 *    start to the show's closing, or to now when it is still running (a
 *    censored observation, so shows that dipped and survived count).
 * 3. A running show under a threshold for E weeks gets the Kaplan-Meier
 *    estimate over past spells that also stayed under for E weeks, shifted
 *    by E: "of past shows stuck this far down this long, when did they close".
 * 4. Reserves are not public, so the cushion is the run's banked operating
 *    profit (weekly gross minus break-even, summed from the first week of the
 *    run) as a share of capitalization when the spell began. Shows that had
 *    banked half their capitalization ran far longer once under (median 68 vs
 *    21 weeks at 90%), so a live show is compared with past spells on its own
 *    side of that line whenever that side alone has enough history.
 *
 * Time is calendar weeks inside the show's final continuous run (a gap of
 * more than CLOSING_WATCH_MAX_GAP_WEEKS, such as the 2020-21 shutdown, starts
 * a new run). Pure: no data imports, so tests require the real functions.
 */

/** Thresholds of adjusted gross / break-even, deepest first. */
export const CLOSING_WATCH_THRESHOLDS = [0.6, 0.75, 0.9, 1] as const;

/** Reported weeks a run needs before its ratio counts (skips the previews ramp). */
export const CLOSING_WATCH_MIN_WEEKS = 8;

/** Observations (and closings among them) needed before we print a window. */
export const CLOSING_WATCH_MIN_SAMPLE = 15;
export const CLOSING_WATCH_MIN_CLOSINGS = 8;

/** Missing weeks in a row that end a run (a shutdown, a transfer), not a skipped report. */
export const CLOSING_WATCH_MAX_GAP_WEEKS = 4;

/** Banked operating profit, as a share of capitalization, that splits "had a cushion" from "did not". */
export const CLOSING_WATCH_CUSHION_SPLIT = 0.5;

/** Designations whose closing is not driven by box office. */
const NOT_BOX_OFFICE_DRIVEN = new Set(['Nonprofit', 'Tour Stop']);

/** Box-office-driven run: not nonprofit, not a tour stop, not a limited engagement. */
export function isBoxOfficeDriven(designation: string | null | undefined, limitedRun: boolean | null | undefined): boolean {
  return !limitedRun && !(designation && NOT_BOX_OFFICE_DRIVEN.has(designation));
}

/** Index (oldest first) where the show's final continuous run starts, -1 when it never reported. */
export function finalRunStart(weekly: Array<number | null | undefined>): number {
  let start = -1;
  let gap = 0;
  for (let i = 0; i < weekly.length; i++) {
    const g = weekly[i];
    if (g == null || !(g > 0)) {
      gap++;
      continue;
    }
    if (start < 0 || gap > CLOSING_WATCH_MAX_GAP_WEEKS) start = i;
    gap = 0;
  }
  return start;
}

function presentSlice(xs: Array<number | null | undefined>, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i <= to; i++) {
    const v = xs[i];
    if (v != null && v > 0) out.push(v);
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Seasonal index per week (oldest first): the market's 4-week average gross
 * per show over its trailing 52-week average. 1 where there is not enough
 * history (fewer than 26 weeks) or no market data.
 */
export function seasonalIndexSeries(marketPerShow: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (let i = 0; i < marketPerShow.length; i++) {
    const recent = presentSlice(marketPerShow, i - 3, i);
    const year = presentSlice(marketPerShow, i - 51, i);
    out.push(recent.length >= 3 && year.length >= 26 ? mean(recent) / mean(year) : 1);
  }
  return out;
}

/**
 * Ratio series over the final run (oldest first, one entry per calendar week
 * from finalRunStart to the last week given): seasonally adjusted 4-week
 * average gross / break-even, null before the run has
 * CLOSING_WATCH_MIN_WEEKS reported weeks or in a week the show did not report.
 */
export function adjustedRatioSeries(
  weekly: Array<number | null | undefined>,
  seasonal: number[],
  breakEven: number,
): Array<number | null> {
  const start = finalRunStart(weekly);
  if (start < 0 || !(breakEven > 0)) return [];
  const out: Array<number | null> = [];
  const grosses: number[] = [];
  const idx: number[] = [];
  for (let i = start; i < weekly.length; i++) {
    const g = weekly[i];
    if (g == null || !(g > 0)) {
      out.push(null);
      continue;
    }
    grosses.push(g);
    idx.push(seasonal[i] || 1);
    if (grosses.length < CLOSING_WATCH_MIN_WEEKS) {
      out.push(null);
      continue;
    }
    out.push(mean(grosses.slice(-4)) / breakEven / mean(idx.slice(-4)));
  }
  return out;
}

/**
 * Banked operating profit per week over the final run (aligned with
 * adjustedRatioSeries): running sum of gross minus break-even from the run's
 * first week, over capitalization. Empty without a capitalization.
 */
export function bankedShareSeries(
  weekly: Array<number | null | undefined>,
  breakEven: number,
  capitalization: number | null | undefined,
): Array<number | null> {
  const start = finalRunStart(weekly);
  if (start < 0 || !(breakEven > 0) || !capitalization || !(capitalization > 0)) return [];
  const out: Array<number | null> = [];
  let banked = 0;
  for (let i = start; i < weekly.length; i++) {
    const g = weekly[i];
    if (g != null && g > 0) banked += g - breakEven;
    out.push(banked / capitalization);
  }
  return out;
}

export interface ClosingObservation {
  /** Weeks from the spell's start to closing (closed) or to now (still running). */
  weeks: number;
  closed: boolean;
  /** Weeks the spell stayed under the threshold before recovering (or to the end). Absent = the whole span. */
  under?: number;
  /** Banked share of capitalization when the spell began (bankedShareSeries); null/absent = unknown. */
  cushion?: number | null;
}

/**
 * Spells under each threshold. `ratios` is adjustedRatioSeries for the run,
 * ending at the closing week (closed) or the latest week (running); a null
 * week keeps the previous state.
 */
export function spellObservations(
  ratios: Array<number | null>,
  closed: boolean,
  banked: Array<number | null> = [],
): ClosingObservation[][] {
  const out: ClosingObservation[][] = CLOSING_WATCH_THRESHOLDS.map(() => []);
  const end = ratios.length - 1;
  CLOSING_WATCH_THRESHOLDS.forEach((threshold, t) => {
    let start = -1;
    const close = (until: number) => {
      out[t].push({ weeks: end - start, closed, under: until - start, cushion: banked[start] ?? null });
      start = -1;
    };
    ratios.forEach((r, i) => {
      if (r == null) return;
      if (r < threshold && start < 0) start = i;
      else if (r >= threshold && start >= 0) close(i);
    });
    if (start >= 0) close(end);
  });
  return out;
}

/** Pools observations from every run into one list per threshold. */
export function calibrateClosingWatch(
  runs: Array<{ ratios: Array<number | null>; closed: boolean; banked?: Array<number | null> }>,
): ClosingObservation[][] {
  const pooled: ClosingObservation[][] = CLOSING_WATCH_THRESHOLDS.map(() => []);
  for (const run of runs) {
    spellObservations(run.ratios, run.closed, run.banked).forEach((obs, t) => pooled[t].push(...obs));
  }
  return pooled;
}

/**
 * Kaplan-Meier: the first week by which a `q` share of the observations had
 * closed (censored ones leave the risk set without counting). null when the
 * curve never gets there (too many still running).
 */
export function kaplanMeierQuantile(obs: ClosingObservation[], q: number): number | null {
  const sorted = [...obs].sort((a, b) => a.weeks - b.weeks);
  let atRisk = sorted.length;
  let survival = 1;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].weeks;
    let events = 0;
    let leaving = 0;
    while (i < sorted.length && sorted[i].weeks === t) {
      if (sorted[i].closed) events++;
      leaving++;
      i++;
    }
    if (events > 0) {
      survival *= 1 - events / atRisk;
      if (1 - survival >= q - 1e-9) return t;
    }
    atRisk -= leaving;
  }
  return null;
}

export interface ClosingEstimate {
  /** Threshold the show is under (its deepest one). */
  threshold: number;
  /** Weeks it has been under that threshold. */
  weeksUnder: number;
  /** Past observations behind the estimate, and how many of them closed. */
  sample: number;
  closings: number;
  /** Weeks from now by which a quarter, half and three quarters had closed; null = not reached. */
  p25: number | null;
  median: number;
  p75: number | null;
  /** Which past spells it was compared with: those that had banked at least / less than CLOSING_WATCH_CUSHION_SPLIT, or all (null). */
  cushion: 'banked' | 'thin' | null;
}

/** Calendar weeks the series has been under `threshold` (null weeks keep state). */
export function weeksUnderThreshold(ratios: Array<number | null>, threshold: number): number {
  const end = ratios.length - 1;
  let start = -1;
  for (let i = end; i >= 0; i--) {
    const r = ratios[i];
    if (r == null) continue;
    if (r < threshold) start = i;
    else break;
  }
  return start < 0 ? 0 : end - start;
}

/** The estimate for a live show's ratio series, or null without enough history behind it. */
export function estimateClosing(
  ratios: Array<number | null>,
  calibration: ClosingObservation[][],
  banked: Array<number | null> = [],
): ClosingEstimate | null {
  let current: number | null = null;
  for (let i = ratios.length - 1; i >= 0 && current == null; i--) current = ratios[i];
  if (current == null) return null;
  const t = CLOSING_WATCH_THRESHOLDS.findIndex((th) => (current as number) < th);
  if (t < 0) return null;
  const threshold = CLOSING_WATCH_THRESHOLDS[t];
  const weeksUnder = weeksUnderThreshold(ratios, threshold);
  // Same position: past spells that also stayed under this long, and lasted this long.
  const same = (calibration[t] ?? []).filter((o) => o.weeks >= weeksUnder && (o.under ?? o.weeks) >= weeksUnder);
  // Same cushion: compare with past spells that began with as much (or as little) banked, when there are enough.
  const myCushion = banked[ratios.length - 1 - weeksUnder] ?? null;
  const side = myCushion == null ? null : myCushion >= CLOSING_WATCH_CUSHION_SPLIT ? 'banked' : 'thin';
  const sameSide = side == null ? [] : same.filter((o) => o.cushion != null && (o.cushion >= CLOSING_WATCH_CUSHION_SPLIT) === (side === 'banked'));
  const enough = (xs: ClosingObservation[]) =>
    xs.length >= CLOSING_WATCH_MIN_SAMPLE && xs.filter((o) => o.closed).length >= CLOSING_WATCH_MIN_CLOSINGS;
  const cushion = side != null && enough(sameSide) ? side : null;
  const conditional = (cushion ? sameSide : same).map((o) => ({ weeks: o.weeks - weeksUnder, closed: o.closed }));
  const closings = conditional.filter((o) => o.closed).length;
  if (conditional.length < CLOSING_WATCH_MIN_SAMPLE || closings < CLOSING_WATCH_MIN_CLOSINGS) return null;
  const median = kaplanMeierQuantile(conditional, 0.5);
  if (median == null) return null;
  return {
    threshold,
    weeksUnder,
    sample: conditional.length,
    closings,
    p25: kaplanMeierQuantile(conditional, 0.25),
    median,
    p75: kaplanMeierQuantile(conditional, 0.75),
    cushion,
  };
}

export interface ClosingWatchInput {
  status: string | null | undefined;
  designation: string | null | undefined;
  limitedRun?: boolean | null;
  /** shows.json closingDate, any form. */
  closingDate: string | null | undefined;
  /** YYYY-MM-DD. */
  today: string;
  /** Raw 4-week average gross (what the card prints). */
  avgGross: number | null;
  breakEven: number | null;
  /** Latest seasonally adjusted ratio, null when the run is too new. */
  adjustedRatio: number | null;
}

/**
 * On the watch: running, box-office-driven, no closing date still ahead, past
 * the previews ramp, and under break-even both as printed and after the
 * seasonal adjustment (a January dip alone does not list a hit). Recouped
 * shows count too: a hit that slips under break-even can still close.
 */
export function isOnClosingWatch(input: ClosingWatchInput): boolean {
  if (input.status !== 'open' && input.status !== 'previews') return false;
  if (!isBoxOfficeDriven(input.designation, input.limitedRun)) return false;
  const close = (input.closingDate ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(close) && close >= input.today) return false;
  if (input.avgGross == null || input.breakEven == null || input.breakEven <= 0) return false;
  if (input.adjustedRatio == null || input.adjustedRatio >= 1) return false;
  return input.avgGross < input.breakEven;
}

/** YYYY-MM-DD plus whole weeks. */
export function addWeeks(isoDate: string, weeks: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** Consecutive reported weeks, newest first, whose gross was under break-even (missing weeks skipped). */
export function weeksBelowBreakEven(grossesNewestFirst: Array<number | null>, breakEven: number): number {
  let n = 0;
  for (const g of grossesNewestFirst) {
    if (g == null) continue;
    if (g >= breakEven) break;
    n++;
  }
  return n;
}
