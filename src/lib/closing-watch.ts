/**
 * Closing Watch (BRO-7246): running Broadway shows that have not announced a
 * closing but whose grosses trail break-even, with our estimate of when they
 * are likely to close.
 *
 * The estimate is an extrapolation, marked as ours on the page. It comes from
 * the shows that already closed: for each one we find the first week its
 * 4-week average gross fell into a band (under 60% of break-even, 60-75%,
 * 75-90%, 90-100%) and count the weeks it kept running after that. A running
 * show in the same band today gets that band's quartiles as its likely
 * window. The calibration is recomputed from the data on every build.
 *
 * Pure: no data imports, so tests require the real functions (CLAUDE.md §15).
 */

/** Gross / break-even bands, deepest first. `max` is exclusive. */
export const CLOSING_WATCH_BANDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 0.6 },
  { min: 0.6, max: 0.75 },
  { min: 0.75, max: 0.9 },
  { min: 0.9, max: 1 },
];

/** Reported weeks a show needs before it can be watched (skips the previews ramp). */
export const CLOSING_WATCH_MIN_WEEKS = 8;

/** Past shows a band needs before we print a window from it. */
export const CLOSING_WATCH_MIN_SAMPLE = 15;

/** Designations whose closing is not driven by box office. */
const NOT_BOX_OFFICE_DRIVEN = new Set(['Nonprofit', 'Tour Stop']);

export interface ClosingCalibrationShow {
  /** Every reported weekly gross for the run, oldest first. */
  grossesOldestFirst: number[];
  breakEven: number;
}

export interface ClosingBandStats {
  min: number;
  max: number;
  /** Past shows that reached this band. */
  sample: number;
  /** Weeks those shows kept running after first reaching the band. */
  p25: number;
  median: number;
  p75: number;
}

/** Linear-interpolated quantile of a sorted list (0..1). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bandIndex(ratio: number): number {
  return CLOSING_WATCH_BANDS.findIndex((b) => ratio >= b.min && ratio < b.max);
}

/** Weeks each closed show kept running after first reaching each band. */
export function calibrateClosingWatch(shows: ClosingCalibrationShow[]): ClosingBandStats[] {
  const weeksLeft: number[][] = CLOSING_WATCH_BANDS.map(() => []);
  for (const { grossesOldestFirst: g, breakEven } of shows) {
    if (!(breakEven > 0) || g.length < CLOSING_WATCH_MIN_WEEKS + 2) continue;
    const seen = new Set<number>();
    for (let i = CLOSING_WATCH_MIN_WEEKS - 1; i < g.length; i++) {
      const avg = (g[i] + g[i - 1] + g[i - 2] + g[i - 3]) / 4;
      const b = bandIndex(avg / breakEven);
      if (b >= 0 && !seen.has(b)) {
        seen.add(b);
        weeksLeft[b].push(g.length - 1 - i);
      }
    }
  }
  return CLOSING_WATCH_BANDS.map((band, i) => {
    const sorted = [...weeksLeft[i]].sort((a, b) => a - b);
    return {
      ...band,
      sample: sorted.length,
      p25: Math.round(quantile(sorted, 0.25)),
      median: Math.round(quantile(sorted, 0.5)),
      p75: Math.round(quantile(sorted, 0.75)),
    };
  });
}

/** The band a gross / break-even ratio falls in, when it has enough past shows. */
export function closingBandFor(ratio: number, calibration: ClosingBandStats[]): ClosingBandStats | null {
  const b = calibration.find((s) => ratio >= s.min && ratio < s.max);
  return b && b.sample >= CLOSING_WATCH_MIN_SAMPLE ? b : null;
}

export interface ClosingWatchInput {
  status: string | null | undefined;
  designation: string | null | undefined;
  /** shows.json closingDate, any form. */
  closingDate: string | null | undefined;
  /** YYYY-MM-DD. */
  today: string;
  avgGross: number | null;
  breakEven: number | null;
  /** Weeks the show has reported grosses. */
  reportedWeeks: number;
}

/**
 * On the watch: running, box-office-driven, no closing date still ahead,
 * past the previews ramp, and its 4-week average under break-even. Recouped
 * shows count too: a hit that slips under break-even can still close.
 */
export function isOnClosingWatch(input: ClosingWatchInput): boolean {
  if (input.status !== 'open' && input.status !== 'previews') return false;
  if (input.designation && NOT_BOX_OFFICE_DRIVEN.has(input.designation)) return false;
  const close = (input.closingDate ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(close) && close >= input.today) return false;
  if (input.reportedWeeks < CLOSING_WATCH_MIN_WEEKS) return false;
  if (input.avgGross == null || input.breakEven == null || input.breakEven <= 0) return false;
  return input.avgGross < input.breakEven;
}

/** YYYY-MM-DD plus whole weeks. */
export function addWeeks(isoDate: string, weeks: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** Consecutive weeks, newest first, whose gross was under break-even. */
export function weeksBelowBreakEven(grossesNewestFirst: Array<number | null>, breakEven: number): number {
  let n = 0;
  for (const g of grossesNewestFirst) {
    if (g == null || g >= breakEven) break;
    n++;
  }
  return n;
}
