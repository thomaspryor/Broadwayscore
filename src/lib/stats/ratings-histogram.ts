/**
 * ratingsHistogram — the half-star distribution with your-average marker
 * (spec §3.4).
 *
 * Ten fixed buckets, 0.5 through 5.0, always all present so the chart never
 * changes shape as a diary grows. Null-rated entries count toward `total` (the
 * "186 of 195 shows rated" footer taps to the unrated list) but never enter a
 * bucket and never influence the average.
 */

import type { DiaryRow } from './types';
import { MAX_RATING, MIN_RATING, RATING_STEP, parseRating } from './parse';

export interface HistogramBucket {
  /** Bucket value: 0.5, 1.0, … 5.0. */
  value: number;
  count: number;
  /** count / rated, 0 when nothing is rated. */
  share: number;
}

export interface RatingsHistogram {
  /** All rows, rated or not. */
  total: number;
  rated: number;
  unrated: number;
  /** Ten buckets ascending, always 0.5 → 5.0. */
  buckets: HistogramBucket[];
  /** Mean of rated entries, rounded to 2dp; null when nothing is rated. */
  average: number | null;
  /** Median of rated entries; null when nothing is rated. */
  median: number | null;
  /** Most common bucket value; null when nothing is rated. */
  mode: number | null;
  /** Show ids with no usable rating, in input order. */
  unratedShowIds: string[];
}

/** The ten legal half-star values, 0.5 → 5.0. */
export function ratingBuckets(): number[] {
  const out: number[] = [];
  for (let v = MIN_RATING; v <= MAX_RATING + 1e-9; v += RATING_STEP) {
    out.push(Math.round(v * 2) / 2);
  }
  return out;
}

export function ratingsHistogram(rows: DiaryRow[]): RatingsHistogram {
  const values = ratingBuckets();
  const counts = new Map<number, number>(values.map((v) => [v, 0]));
  const rated: number[] = [];
  const unratedShowIds: string[] = [];

  for (const row of rows) {
    const r = parseRating(row.rating);
    if (r === null) {
      unratedShowIds.push(row.show_id);
      continue;
    }
    rated.push(r);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }

  const buckets: HistogramBucket[] = values.map((value) => {
    const count = counts.get(value) ?? 0;
    return { value, count, share: rated.length ? count / rated.length : 0 };
  });

  let average: number | null = null;
  let median: number | null = null;
  let mode: number | null = null;
  if (rated.length) {
    average = Math.round((rated.reduce((s, v) => s + v, 0) / rated.length) * 100) / 100;
    const sorted = [...rated].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
        : sorted[mid];
    // Ties resolve to the higher star value, matching the ascending scan.
    mode = buckets.reduce((best, b) => (b.count >= best.count ? b : best)).value;
  }

  return {
    total: rows.length,
    rated: rated.length,
    unrated: unratedShowIds.length,
    buckets,
    average,
    median,
    mode,
    unratedShowIds,
  };
}
