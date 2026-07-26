/**
 * Small pure parsers shared by the stats reducers.
 *
 * These exist because two inputs are stringly-typed at their source and every
 * reducer would otherwise re-guess: Supabase returns `numeric` ratings as
 * strings ("4.0"), and shows.json stores runtime as prose ("2h 30m").
 */

import type { StatsShowMeta } from './types';

/** Runtime assumed for a musical when shows.json has none (2h30m). */
export const FALLBACK_RUNTIME_MUSICAL = 150;
/** Runtime assumed for a play (or unknown type) when shows.json has none (2h). */
export const FALLBACK_RUNTIME_PLAY = 120;

/** Lowest / highest legal diary rating, and the step ratings snap to. */
export const MIN_RATING = 0.5;
export const MAX_RATING = 5;
export const RATING_STEP = 0.5;

/**
 * Parse a diary rating to a number in [0.5, 5] snapped to the half-star grid.
 *
 * Returns null for anything unusable — null/undefined, empty string, NaN, or a
 * value at or below zero. Callers treat null as "unrated": it still counts in
 * diary totals but is excluded from the histogram and from critic alignment.
 */
export function parseRating(rating: string | number | null | undefined): number | null {
  if (rating === null || rating === undefined) return null;
  const n = typeof rating === 'number' ? rating : Number(String(rating).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const snapped = Math.round(n / RATING_STEP) * RATING_STEP;
  const clamped = Math.min(MAX_RATING, Math.max(MIN_RATING, snapped));
  // Guard against 0.30000000000000004-style drift from the divide/multiply.
  return Math.round(clamped * 2) / 2;
}

/** A rating expressed on the 0–100 critic scale (★ × 20). */
export function ratingToHundred(rating: number): number {
  return rating * 20;
}

/**
 * Parse shows.json runtime into minutes.
 *
 * Handles "2h 30m", "2h", "95m", "2 hours 30 minutes", "1 hr 45 min", and a
 * bare number (already minutes). Returns null when nothing parses.
 */
export function parseRuntimeMinutes(runtime: string | number | null | undefined): number | null {
  if (runtime === null || runtime === undefined) return null;
  if (typeof runtime === 'number') {
    return Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime) : null;
  }
  const s = String(runtime).trim().toLowerCase();
  if (!s) return null;

  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr\b|hrs\b|hour|hours)/);
  const mins = s.match(/(\d+)\s*(?:m\b|min\b|mins\b|minute|minutes)/);
  if (hours || mins) {
    const total =
      (hours ? parseFloat(hours[1]) * 60 : 0) + (mins ? parseInt(mins[1], 10) : 0);
    return total > 0 ? Math.round(total) : null;
  }

  const bare = s.match(/^\d+(?:\.\d+)?$/);
  if (bare) {
    const n = parseFloat(bare[0]);
    return n > 0 ? Math.round(n) : null;
  }
  return null;
}

export interface ResolvedRuntime {
  minutes: number;
  /** True when the real runtime was unknown and a type-based default was used. */
  fallback: boolean;
}

/**
 * Runtime for one diary entry, falling back to 2h30m for musicals and 2h for
 * everything else. The `fallback` flag is what feeds the >25% "demote the
 * Hours-in-a-seat tile" rule from the spec.
 */
export function resolveRuntimeMinutes(meta: StatsShowMeta | undefined): ResolvedRuntime {
  const parsed = parseRuntimeMinutes(meta?.runtime);
  if (parsed !== null) return { minutes: parsed, fallback: false };
  const isMusical = String(meta?.type ?? '').toLowerCase() === 'musical';
  return {
    minutes: isMusical ? FALLBACK_RUNTIME_MUSICAL : FALLBACK_RUNTIME_PLAY,
    fallback: true,
  };
}

/** "YYYY-MM-DD" → "YYYY-MM"; null for anything that isn't a plain date. */
export function monthKey(dateSeen: string | null | undefined): string | null {
  if (!dateSeen || dateSeen.length < 7) return null;
  const m = dateSeen.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** "YYYY-MM-DD" → 2026; null for anything that isn't a plain date. */
export function yearOf(dateSeen: string | null | undefined): number | null {
  if (!dateSeen) return null;
  const m = dateSeen.match(/^(\d{4})-\d{2}/);
  return m ? parseInt(m[1], 10) : null;
}

/** Step a "YYYY-MM" key forward by one month. */
export function nextMonth(key: string): string {
  const [y, m] = key.split('-').map((v) => parseInt(v, 10));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Number of whole months from `from` to `to`, both "YYYY-MM". */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map((v) => parseInt(v, 10));
  const [ty, tm] = to.split('-').map((v) => parseInt(v, 10));
  return (ty - fy) * 12 + (tm - fm);
}
