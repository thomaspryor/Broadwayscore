/**
 * Pure predicates for the advanced filter panel.
 *
 * Each predicate is a function `(show, ctx) => boolean`. The panel UI in
 * src/components/filters/* wires user toggles to predicate IDs; the
 * predicates run inside a useMemo and have no React dependency.
 *
 * Awards predicates rely on pre-computed Sets in `ctx` — never import
 * awards.json directly here (it's 612KB; see data-awards.ts comment).
 *
 * Score-mode coupling: SCORE_TIER_* predicates evaluate against the
 * currently-active scoreMode (critic vs audience). The hook that owns
 * the panel state passes the right score into ctx.
 */
import type { ShowCardShow } from '@/components/show-cards/types';

export interface FilterPredicateCtx {
  /** Reconstructed Sets from AwardWinnerSets — O(1) lookup */
  tonyWinnerIds: ReadonlySet<string>;
  tonyNomineeIds: ReadonlySet<string>;
  olivierWinnerIds: ReadonlySet<string>;
  olivierNomineeIds: ReadonlySet<string>;
  dramaDeskWinnerIds: ReadonlySet<string>;
  pulitzerWinnerIds: ReadonlySet<string>;
  /** Time-period range — inclusive on both ends; null = no time filter */
  yearRange: { from: number; to: number } | null;
}

export type FilterPredicate = (show: ShowCardShow, ctx: FilterPredicateCtx) => boolean;

// ─────────────── Production ───────────────

export const PRODUCTION_ORIGINAL: FilterPredicate = (s) => s.isRevival !== true;
export const PRODUCTION_REVIVAL: FilterPredicate = (s) => s.isRevival === true;

// ─────────────── Awards ───────────────

export const AWARD_TONY_WINNER: FilterPredicate = (s, ctx) => ctx.tonyWinnerIds.has(s.id);
export const AWARD_TONY_NOMINEE: FilterPredicate = (s, ctx) => ctx.tonyNomineeIds.has(s.id);
export const AWARD_OLIVIER_WINNER: FilterPredicate = (s, ctx) => ctx.olivierWinnerIds.has(s.id);
export const AWARD_OLIVIER_NOMINEE: FilterPredicate = (s, ctx) => ctx.olivierNomineeIds.has(s.id);
export const AWARD_DRAMA_DESK_WINNER: FilterPredicate = (s, ctx) => ctx.dramaDeskWinnerIds.has(s.id);
export const AWARD_PULITZER: FilterPredicate = (s, ctx) => ctx.pulitzerWinnerIds.has(s.id);

// ─────────────── Time period ───────────────

/**
 * Extract the year a show "belongs to" for time-period filtering.
 * Prefers `season` (e.g., "2024-2025" → 2024), falls back to opening-year.
 * Returns null if neither field is usable.
 */
export function getShowYear(show: ShowCardShow): number | null {
  if (show.season) {
    const match = show.season.match(/^(\d{4})/);
    if (match) return parseInt(match[1], 10);
  }
  if (show.openingDate) {
    const year = parseInt(show.openingDate.slice(0, 4), 10);
    if (!isNaN(year)) return year;
  }
  return null;
}

export const TIME_PERIOD_RANGE: FilterPredicate = (s, ctx) => {
  if (!ctx.yearRange) return true;
  const year = getShowYear(s);
  if (year === null) return false;
  return year >= ctx.yearRange.from && year <= ctx.yearRange.to;
};

// ─────────────── Score tier ───────────────
// Uses the canonical buckets from src/config/score-buckets.ts. Filters
// against criticScore for v1 — audience-mode coupling can come later.

const inScoreRange = (min: number, max: number): FilterPredicate => (s) => {
  const score = s.criticScore?.score;
  if (typeof score !== 'number') return false;
  return score >= min && score <= max;
};

export const SCORE_TIER_CRITICAL_GOLD = inScoreRange(83, 100);
export const SCORE_TIER_RECOMMENDED = inScoreRange(75, 82);
export const SCORE_TIER_WORTH_SEEING = inScoreRange(65, 74);
export const SCORE_TIER_SKIPPABLE = inScoreRange(55, 64);
export const SCORE_TIER_CRITICAL_MISS = inScoreRange(0, 54);

// ─────────────── Tickets & access ───────────────

export const TICKETS_LOTTERY: FilterPredicate = (s) => s.tags?.includes('lottery') ?? false;
export const TICKETS_RUSH: FilterPredicate = (s) => s.tags?.includes('rush') ?? false;

// ─────────────── Genre & format (tag-based) ───────────────

const tagPredicate = (tag: string): FilterPredicate => (s) => s.tags?.includes(tag) ?? false;

export const GENRE_COMEDY = tagPredicate('comedy');
export const GENRE_DRAMA = tagPredicate('drama');
export const FORMAT_JUKEBOX = tagPredicate('jukebox');
export const FORMAT_CONCERT = tagPredicate('concert');
export const FORMAT_SOLO_SHOW = tagPredicate('solo-show');
export const FORMAT_IMMERSIVE = tagPredicate('immersive');
export const FORMAT_REVUE = tagPredicate('revue');
export const SOURCE_BASED_ON_BOOK = tagPredicate('based-on-book');
export const SOURCE_BASED_ON_TRUE_STORY = tagPredicate('based-on-true-story');
export const SOURCE_FILM_ADAPTATION = tagPredicate('film-adaptation');
export const SOURCE_DISNEY = tagPredicate('disney');
