/**
 * "You vs. the critics", Critical Gold coverage and "the audience & you".
 *
 * Port of the iOS app's lib/stats-you-vs-critics.ts (BRO-6170 prototype). The
 * app wrote it as pure functions so the web could lift it; it needs only the
 * composite score, review count and audience grade per show (stats-shows.json).
 */

import { parseRating, ratingToHundred } from '@/lib/stats';
import type { DiaryRow } from '@/lib/stats';
import { getMarketMinReviews } from '@/lib/market-utils';
import { isCriticalGold } from '@/config/score-buckets';

/** |your ★×20 − critic score| at or below this counts as agreement. */
export const ALIGNMENT_WINDOW = 10;
/** Module locks below this many rated shows that carry a critic score. */
export const MIN_RATED_WITH_SCORE = 5;
/** A pick has to disagree by at least this much to be shown. */
export const CONTRARIAN_MIN_DELTA = 15;

export interface CriticShowMeta {
  id: string;
  title: string;
  slug?: string;
  compositeScore?: number | null;
  criticReviewCount?: number | null;
  category?: string | null;
  status?: string | null;
  poster?: string | null;
  venue?: string | null;
  audienceGrade?: string | null;
}

export type CriticShowIndex = Record<string, CriticShowMeta>;

export interface ContrarianPick {
  showId: string;
  title: string;
  slug?: string;
  poster?: string | null;
  rating: number;
  criticScore: number;
  category?: string | null;
  /** your★×20 − criticScore. Positive = you liked it more. */
  delta: number;
}

export interface YouVsCriticsResult {
  comparable: number;
  aligned: number;
  alignment: number;
  label: string;
  /** mean(critic) − mean(yours). Negative = critics run colder. */
  bias: number;
  youLovedIt: ContrarianPick[];
  criticsRaved: ContrarianPick[];
  alignedShowIds: string[];
  comparableShowIds: string[];
}

export interface GoldCoverage {
  total: number;
  seen: number;
  unseen: CriticShowMeta[];
  seenShowIds: string[];
}

export interface AudienceAgreement {
  comparable: number;
  aligned: number;
  alignment: number;
  alignedShowIds: string[];
  comparableShowIds: string[];
}

export function alignmentLabel(alignment: number): string {
  if (alignment >= 0.7) return 'In step with the critics';
  if (alignment >= 0.5) return 'Mostly with the critics';
  if (alignment >= 0.3) return 'You go your own way';
  return 'Certified contrarian';
}

export function hasDisplayableScore(meta: CriticShowMeta | undefined): boolean {
  if (!meta || typeof meta.compositeScore !== 'number') return false;
  const min = getMarketMinReviews(meta.category ?? undefined);
  if (typeof meta.criticReviewCount === 'number' && meta.criticReviewCount < min) return false;
  return true;
}

export function youVsCritics(
  rows: DiaryRow[],
  shows: CriticShowIndex,
  opts: { window?: number; limit?: number; minDelta?: number } = {},
): YouVsCriticsResult {
  const window = opts.window ?? ALIGNMENT_WINDOW;
  const limit = opts.limit ?? 3;
  const minDelta = opts.minDelta ?? CONTRARIAN_MIN_DELTA;

  // One rating per show: repeat viewings averaged.
  const byShow = new Map<string, number[]>();
  for (const row of rows) {
    const r = parseRating(row.rating);
    if (r === null) continue;
    const list = byShow.get(row.show_id);
    if (list) list.push(r);
    else byShow.set(row.show_id, [r]);
  }

  const picks: ContrarianPick[] = [];
  const alignedShowIds: string[] = [];
  const comparableShowIds: string[] = [];
  let sumYours = 0;
  let sumTheirs = 0;

  byShow.forEach((ratings, showId) => {
    const meta = shows[showId];
    if (!hasDisplayableScore(meta)) return;
    const rating = ratings.reduce((s, v) => s + v, 0) / ratings.length;
    const yours = ratingToHundred(rating);
    const theirs = meta.compositeScore as number;
    comparableShowIds.push(showId);
    sumYours += yours;
    sumTheirs += theirs;
    if (Math.abs(yours - theirs) <= window) alignedShowIds.push(showId);
    picks.push({
      showId,
      title: meta.title,
      slug: meta.slug,
      poster: meta.poster ?? null,
      rating,
      criticScore: theirs,
      category: meta.category ?? null,
      delta: yours - theirs,
    });
  });

  const comparable = comparableShowIds.length;
  const aligned = alignedShowIds.length;
  const alignment = comparable > 0 ? aligned / comparable : 0;

  return {
    comparable,
    aligned,
    alignment,
    label: alignmentLabel(alignment),
    bias: comparable > 0 ? (sumTheirs - sumYours) / comparable : 0,
    youLovedIt: picks.filter((p) => p.delta >= minDelta).sort((a, b) => b.delta - a.delta).slice(0, limit),
    criticsRaved: picks.filter((p) => p.delta <= -minDelta).sort((a, b) => a.delta - b.delta).slice(0, limit),
    alignedShowIds,
    comparableShowIds,
  };
}

/** Of the shows open right now at Critical Gold, how many have you ever seen. */
export function goldCoverage(rows: DiaryRow[], openShows: CriticShowMeta[]): GoldCoverage {
  const seenIds = new Set(rows.map((r) => r.show_id));
  const gold = openShows.filter(
    (s) => hasDisplayableScore(s) && isCriticalGold(s.compositeScore, s.category ?? undefined),
  );
  const seen = gold.filter((s) => seenIds.has(s.id));
  const unseen = gold
    .filter((s) => !seenIds.has(s.id))
    .sort((a, b) => (b.compositeScore as number) - (a.compositeScore as number));
  return { total: gold.length, seen: seen.length, unseen, seenShowIds: seen.map((s) => s.id) };
}

/** Letter grade → 0-100 midpoint, matching the site's grade bands. */
const GRADE_SCORES: Record<string, number> = {
  'A+': 97, A: 93, 'A-': 90,
  'B+': 87, B: 83, 'B-': 80,
  'C+': 77, C: 73, 'C-': 70,
  'D+': 67, D: 63, 'D-': 60,
  F: 50,
};

/** Your ★×20 against each show's audience grade, same ±10 band as critics. */
export function audienceVsYou(rows: DiaryRow[], index: CriticShowIndex): AudienceAgreement {
  const byShow = new Map<string, number>();
  for (const r of rows) {
    const rating = parseRating(r.rating);
    if (rating !== null && !byShow.has(r.show_id)) byShow.set(r.show_id, rating);
  }
  const comparableShowIds: string[] = [];
  const alignedShowIds: string[] = [];
  byShow.forEach((rating, showId) => {
    const grade = index[showId]?.audienceGrade;
    const theirs = grade ? GRADE_SCORES[grade] : undefined;
    if (theirs === undefined) return;
    comparableShowIds.push(showId);
    if (Math.abs(rating * 20 - theirs) <= ALIGNMENT_WINDOW) alignedShowIds.push(showId);
  });
  const comparable = comparableShowIds.length;
  return {
    comparable,
    aligned: alignedShowIds.length,
    alignment: comparable > 0 ? alignedShowIds.length / comparable : 0,
    alignedShowIds,
    comparableShowIds,
  };
}
