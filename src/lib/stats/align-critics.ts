/**
 * alignCritics — "Aisle Mates" and "Your Paper of Record" (spec §5.1).
 *
 * Alignment is the share of shared shows where |your ★×20 − their score| ≤ 12
 * (about half a star). Thresholds are calibrated against the real corpus, not
 * invented: critic-vs-critic alignment spans only ~35–68% under this window,
 * and the owner's 107-entry diary put six 5-shared-show critics above his true
 * best match — hence the ≥15 volume floor for the headline ranking, with 5–14
 * shared shows demoted to a "rising" row.
 *
 * Pure: rows + the parsed stats-reviews artifact in, plain objects out.
 */

import { NO_CRITIC_INDEX } from './types';
import type { DiaryRow, StatsReviews } from './types';
import { parseRating, ratingToHundred } from './parse';

/** Shared shows required to appear in the headline Aisle Mates ranking. */
export const TOP_MATE_MIN_SHARED = 15;
/** Shared shows required to appear in the secondary "rising matches" row. */
export const RISING_MIN_SHARED = 5;
/** Shared shows required to be eligible as a nemesis. */
export const NEMESIS_MIN_SHARED = 8;
/** |your score − their score| at or below this counts as agreement. */
export const ALIGNMENT_WINDOW = 12;
/** Alignment below this is nemesis territory (spec's recalibrated bands). */
export const LOW_ALIGNMENT_MAX = 0.45;

export interface Alignment {
  /** Critic name, or outlet name for outlet-level alignment. */
  name: string;
  /** Index into `critics` / `outlets`; -1 for aggregates without one. */
  index: number;
  /** Shows both you and they rated. */
  shared: number;
  /** Shared shows inside the ±12 window. */
  aligned: number;
  /** aligned / shared, 0–1. */
  alignment: number;
  /**
   * Mean(their score) − mean(your ★×20) across shared shows. Negative means
   * they run colder than you.
   */
  bias: number;
}

export interface OutletAlignment extends Alignment {
  /** Outlet tier from the artifact (1 = T1). */
  tier: number;
}

export interface AlignCriticsResult {
  /** Every critic with ≥1 shared show, sorted by alignment then volume. */
  critics: Alignment[];
  /** Best matches at ≥15 shared shows. */
  topMates: Alignment[];
  /** 5–14 shared shows — promising, but too thin to headline. */
  rising: Alignment[];
  /** Lowest alignment at ≥8 shared shows. */
  nemesis: Alignment | null;
  /** The most-shared critic who still aligns below LOW_ALIGNMENT_MAX. */
  highVolumeNemesis: Alignment | null;

  outlets: OutletAlignment[];
  topOutlets: OutletAlignment[];
  nemesisOutlet: OutletAlignment | null;

  /** Rated diary shows that exist in the reviews artifact. */
  sharedShowCount: number;
  /** Rated diary shows with no entry in the artifact. */
  unmatchedShowCount: number;
}

export interface AlignCriticsOptions {
  window?: number;
  topMateMinShared?: number;
  risingMinShared?: number;
  nemesisMinShared?: number;
  lowAlignmentMax?: number;
  /** How many entries to return in topMates / rising / topOutlets. */
  limit?: number;
}

interface Tally {
  shared: number;
  aligned: number;
  sumTheirs: number;
  sumYours: number;
}

function emptyTally(): Tally {
  return { shared: 0, aligned: 0, sumTheirs: 0, sumYours: 0 };
}

function toAlignment(name: string, index: number, t: Tally): Alignment {
  return {
    name,
    index,
    shared: t.shared,
    aligned: t.aligned,
    alignment: t.shared > 0 ? t.aligned / t.shared : 0,
    bias: t.shared > 0 ? (t.sumTheirs - t.sumYours) / t.shared : 0,
  };
}

/** Best-first: alignment desc, then volume desc, then name for stability. */
function byBest(a: Alignment, b: Alignment): number {
  if (b.alignment !== a.alignment) return b.alignment - a.alignment;
  if (b.shared !== a.shared) return b.shared - a.shared;
  return a.name.localeCompare(b.name);
}

/** Worst-first: alignment asc, then volume desc, then name. */
function byWorst(a: Alignment, b: Alignment): number {
  if (a.alignment !== b.alignment) return a.alignment - b.alignment;
  if (b.shared !== a.shared) return b.shared - a.shared;
  return a.name.localeCompare(b.name);
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function alignCritics(
  rows: DiaryRow[],
  reviews: StatsReviews,
  opts: AlignCriticsOptions = {}
): AlignCriticsResult {
  const window = opts.window ?? ALIGNMENT_WINDOW;
  const topFloor = opts.topMateMinShared ?? TOP_MATE_MIN_SHARED;
  const risingFloor = opts.risingMinShared ?? RISING_MIN_SHARED;
  const nemesisFloor = opts.nemesisMinShared ?? NEMESIS_MIN_SHARED;
  const lowMax = opts.lowAlignmentMax ?? LOW_ALIGNMENT_MAX;
  const limit = opts.limit ?? 3;

  const critics = reviews?.critics ?? [];
  const outlets = reviews?.outlets ?? [];
  const showRows = reviews?.shows ?? {};

  // One user score per show. Repeat viewings are averaged so the result does
  // not depend on row order.
  const userRatings = new Map<string, number[]>();
  for (const row of rows) {
    const r = parseRating(row.rating);
    if (r === null) continue;
    const list = userRatings.get(row.show_id);
    if (list) list.push(ratingToHundred(r));
    else userRatings.set(row.show_id, [ratingToHundred(r)]);
  }

  const criticTallies = new Map<number, Tally>();
  const outletTallies = new Map<number, Tally>();
  let sharedShowCount = 0;
  let unmatchedShowCount = 0;

  Array.from(userRatings.entries()).forEach(([showId, scores]) => {
    const reviewRows = showRows[showId];
    if (!reviewRows || reviewRows.length === 0) {
      unmatchedShowCount++;
      return;
    }
    sharedShowCount++;
    const yours = mean(scores);

    // Per show: one data point per critic and one per outlet. A critic who
    // filed twice for the same show counts once (mean of their scores); an
    // outlet's score is the mean of ALL its reviews for the show, including
    // byline-less (criticIdx -1) ones.
    const perCritic = new Map<number, number[]>();
    const perOutlet = new Map<number, number[]>();
    for (const [criticIdx, outletIdx, score] of reviewRows) {
      if (!Number.isFinite(score)) continue;
      if (criticIdx !== NO_CRITIC_INDEX && criticIdx >= 0) {
        const c = perCritic.get(criticIdx);
        if (c) c.push(score);
        else perCritic.set(criticIdx, [score]);
      }
      if (outletIdx >= 0) {
        const o = perOutlet.get(outletIdx);
        if (o) o.push(score);
        else perOutlet.set(outletIdx, [score]);
      }
    }

    const record = (tallies: Map<number, Tally>, idx: number, theirs: number) => {
      let t = tallies.get(idx);
      if (!t) {
        t = emptyTally();
        tallies.set(idx, t);
      }
      t.shared++;
      t.sumTheirs += theirs;
      t.sumYours += yours;
      if (Math.abs(yours - theirs) <= window) t.aligned++;
    };

    perCritic.forEach((scoreList, idx) => record(criticTallies, idx, mean(scoreList)));
    perOutlet.forEach((scoreList, idx) => record(outletTallies, idx, mean(scoreList)));
  });

  const criticList: Alignment[] = [];
  criticTallies.forEach((t, idx) => {
    criticList.push(toAlignment(critics[idx] ?? `critic:${idx}`, idx, t));
  });
  criticList.sort(byBest);

  const outletList: OutletAlignment[] = [];
  outletTallies.forEach((t, idx) => {
    const entry = outlets[idx];
    outletList.push({
      ...toAlignment(entry?.[0] ?? `outlet:${idx}`, idx, t),
      tier: entry?.[1] ?? 0,
    });
  });
  outletList.sort(byBest);

  const topMates = criticList.filter((c) => c.shared >= topFloor).slice(0, limit);
  const rising = criticList
    .filter((c) => c.shared >= risingFloor && c.shared < topFloor)
    .slice(0, limit);

  const nemesisPool = criticList.filter((c) => c.shared >= nemesisFloor);
  const nemesis = nemesisPool.length ? [...nemesisPool].sort(byWorst)[0] : null;
  const lowAligners = nemesisPool.filter((c) => c.alignment < lowMax);
  const highVolumeNemesis = lowAligners.length
    ? lowAligners.reduce((best, c) =>
        c.shared > best.shared || (c.shared === best.shared && c.alignment < best.alignment)
          ? c
          : best
      )
    : null;

  const topOutlets = outletList.filter((o) => o.shared >= topFloor).slice(0, limit);
  const outletNemesisPool = outletList.filter((o) => o.shared >= nemesisFloor);
  const nemesisOutlet = outletNemesisPool.length
    ? ([...outletNemesisPool].sort(byWorst)[0] as OutletAlignment)
    : null;

  return {
    critics: criticList,
    topMates,
    rising,
    nemesis,
    highVolumeNemesis,
    outlets: outletList,
    topOutlets,
    nemesisOutlet,
    sharedShowCount,
    unmatchedShowCount,
  };
}
