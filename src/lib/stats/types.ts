/**
 * Shared input types for src/lib/stats/ reducers.
 *
 * Pure data shapes only — no I/O, no React. Every reducer takes its data as
 * arguments so the same functions run in the web app, in node:test, and (via
 * the vendoring pattern) in the iOS app.
 */

/**
 * One diary row, mirroring Supabase `public.reviews`.
 *
 * `rating` arrives as a STRING from PostgREST (numeric column) — "4.0", not 4.
 * `date_seen` is a plain calendar date ("YYYY-MM-DD") with no timezone; all
 * date logic in this module is string comparison, never Date arithmetic on
 * local time.
 */
export interface DiaryRow {
  show_id: string;
  rating: string | number | null;
  date_seen: string | null;
}

/** Per-show metadata the reducers need, keyed by show id. */
export interface StatsShowMeta {
  /** 'musical' | 'play' | anything else; drives the runtime fallback. */
  type?: string | null;
  /** Runtime as stored in shows.json ("2h 30m") or already-parsed minutes. */
  runtime?: string | number | null;
  venue?: string | null;
  /** 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end' | 'regional' | … */
  category?: string | null;
  title?: string | null;
}

export type ShowMetaIndex = Record<string, StatsShowMeta>;

/** One Tony ceremony from public/data/stats-canon.json. */
export interface CanonCeremony {
  ceremony: number;
  /** "YYYY-MM-DD" */
  date: string;
}

/** One Best Musical / Best Play winner from public/data/stats-canon.json. */
export interface CanonWinner {
  ceremony: number;
  /** "YYYY-YY", e.g. "2021-22" */
  season: string;
  id: string;
  t: string;
  img?: string;
}

export interface StatsCanon {
  _v?: number;
  ceremonies: CanonCeremony[];
  bestMusical: CanonWinner[];
  bestPlay: CanonWinner[];
}

/**
 * public/data/stats-reviews.json — interned to keep the payload small.
 *
 * `critics[i]` is a critic name; `outlets[i]` is `[name, tier]`; each show maps
 * to rows of `[criticIdx, outletIdx, score]`. A `criticIdx` of -1 means the
 * review has no usable byline: it is excluded from per-critic alignment but
 * still counts toward its outlet's per-show mean.
 */
export interface StatsReviews {
  _v?: number;
  critics: string[];
  outlets: [string, number][];
  shows: Record<string, [number, number, number][]>;
}

/** Sentinel used by stats-reviews.json for a byline-less review. */
export const NO_CRITIC_INDEX = -1;
