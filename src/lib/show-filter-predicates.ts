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
import type { DateRange } from '@/lib/tony-seasons';
import { getScoreTierId } from '../../scripts/lib/score-tiers';

type ScoreTierId = ReturnType<typeof getScoreTierId>;

export interface FilterPredicateCtx {
  /** Reconstructed Sets from AwardWinnerSets — O(1) lookup */
  tonyWinnerIds: ReadonlySet<string>;
  tonyNomineeIds: ReadonlySet<string>;
  olivierWinnerIds: ReadonlySet<string>;
  olivierNomineeIds: ReadonlySet<string>;
  dramaDeskWinnerIds: ReadonlySet<string>;
  pulitzerWinnerIds: ReadonlySet<string>;
  /** Time-period date ranges (ISO YYYY-MM-DD). Empty = no filter. Multiple = OR. */
  dateRanges: DateRange[];
  /** Active score-mode — score-tier predicates evaluate against this score */
  scoreMode: 'critics' | 'audience';
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
//
// Filters by `openingDate` (ISO YYYY-MM-DD) against any active date range.
// Tony season pills set April 28 → April 27 windows; decade and slider pills
// set calendar-year windows (Jan 1 → Dec 31). See src/lib/tony-seasons.ts.
// Multiple ranges OR together — show passes if openingDate is in any.
// String comparison is correct because ISO 8601 dates sort lexicographically.

export const TIME_PERIOD_RANGE: FilterPredicate = (s, ctx) => {
  if (ctx.dateRanges.length === 0) return true;
  if (!s.openingDate) return false;
  const opened = s.openingDate;
  return ctx.dateRanges.some((r) => opened >= r.from && opened <= r.to);
};

// ─────────────── Score tier ───────────────
// Reads the score that matches the active scoreMode (critics vs audience).
// Tier boundaries come from scripts/lib/score-tiers.js (re-exported by
// score-buckets.ts). Critics mode tiers by the show's market exactly like the
// badge (West End Critical Gold starts at 85); audience mode has no
// market-specific tiers, so it uses the default bands.
const inScoreTier = (tierId: ScoreTierId): FilterPredicate => (s, ctx) => {
  const audience = ctx.scoreMode === 'audience';
  const score = audience ? s.audienceCombinedScore : s.criticScore?.score;
  if (typeof score !== 'number') return false;
  // Round to match the displayed badge (e.g. 82.94 shows as 83) — a raw
  // fractional score can fall in the open interval between two tiers
  // (54-55, 64-65, etc.) and match neither without this.
  return getScoreTierId(Math.round(score), audience ? undefined : s.category) === tierId;
};

export const SCORE_TIER_CRITICAL_GOLD = inScoreTier('must-see');
export const SCORE_TIER_RECOMMENDED = inScoreTier('recommended');
export const SCORE_TIER_WORTH_SEEING = inScoreTier('worth-seeing');
export const SCORE_TIER_SKIPPABLE = inScoreTier('skippable');
export const SCORE_TIER_CRITICAL_MISS = inScoreTier('stay-away');

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
