/**
 * Single source of truth for panel filter UI metadata + predicate wiring.
 * The panel reads this to render groups; the hook reads it to apply
 * predicates against the show list.
 *
 * Discriminated union (`kind`):
 *  - 'multi'  → multi-select pills, predicate-driven (Production, Awards, etc.)
 *  - 'single' → single-select pills mirrored from inline ToggleBars (Type, Status).
 *               No predicate — inline filter logic upstream already filters
 *               the `shows` array on these params; the panel just mirrors URL state.
 */
import {
  type FilterPredicate,
  PRODUCTION_ORIGINAL,
  PRODUCTION_REVIVAL,
  AWARD_TONY_WINNER,
  AWARD_TONY_NOMINEE,
  AWARD_OLIVIER_WINNER,
  AWARD_OLIVIER_NOMINEE,
  AWARD_DRAMA_DESK_WINNER,
  SCORE_TIER_CRITICAL_GOLD,
  SCORE_TIER_RECOMMENDED,
  SCORE_TIER_WORTH_SEEING,
  SCORE_TIER_SKIPPABLE,
  SCORE_TIER_CRITICAL_MISS,
  TICKETS_LOTTERY,
  TICKETS_RUSH,
  GENRE_COMEDY,
  GENRE_DRAMA,
  FORMAT_JUKEBOX,
  SOURCE_BASED_ON_BOOK,
  SOURCE_BASED_ON_TRUE_STORY,
  SOURCE_FILM_ADAPTATION,
  SOURCE_DISNEY,
} from '@/lib/show-filter-predicates';
// Excluded from v1 — match 0 (concert, revue) or 0 currently-open shows
// (solo-show, immersive). Predicates remain in show-filter-predicates.ts
// and can be re-added when tag coverage improves.
// AWARD_PULITZER: 1 entry in awards.json (Hamilton only) — defer until backfilled.

export interface FilterOption {
  /** Stable id — used in URL and as predicate key */
  id: string;
  label: string;
  predicate: FilterPredicate;
}

export interface MultiGroupConfig {
  kind: 'multi';
  /** URL param key (e.g. "production") — comma-separated multi-value */
  paramKey: string;
  label: string;
  options: FilterOption[];
}

export interface SingleOption {
  id: string;
  label: string;
}

export interface SingleGroupConfig {
  kind: 'single';
  /** URL param key (e.g. "type", "status") — single value */
  paramKey: string;
  label: string;
  /** Param value treated as "no filter" — chip + badge suppressed when current */
  defaultValue: string;
  options: SingleOption[];
}

export type FilterGroupConfig = MultiGroupConfig | SingleGroupConfig;

export const FILTER_GROUPS: MultiGroupConfig[] = [
  {
    kind: 'multi',
    paramKey: 'production',
    label: 'Production',
    options: [
      { id: 'original', label: 'Original', predicate: PRODUCTION_ORIGINAL },
      { id: 'revival', label: 'Revival', predicate: PRODUCTION_REVIVAL },
    ],
  },
  {
    kind: 'multi',
    paramKey: 'score_tier',
    label: 'Score tier',
    options: [
      { id: 'critical-gold', label: 'Critical Gold (83+)', predicate: SCORE_TIER_CRITICAL_GOLD },
      { id: 'recommended', label: 'Recommended (75–82)', predicate: SCORE_TIER_RECOMMENDED },
      { id: 'worth-seeing', label: 'Worth Seeing (65–74)', predicate: SCORE_TIER_WORTH_SEEING },
      { id: 'skippable', label: 'Skippable (55–64)', predicate: SCORE_TIER_SKIPPABLE },
      { id: 'critical-miss', label: 'Critical Miss (<55)', predicate: SCORE_TIER_CRITICAL_MISS },
    ],
  },
  {
    kind: 'multi',
    paramKey: 'awards',
    label: 'Awards',
    options: [
      { id: 'tony-winner', label: 'Tony winner', predicate: AWARD_TONY_WINNER },
      { id: 'tony-nominee', label: 'Tony nominee', predicate: AWARD_TONY_NOMINEE },
      { id: 'olivier-winner', label: 'Olivier winner', predicate: AWARD_OLIVIER_WINNER },
      { id: 'olivier-nominee', label: 'Olivier nominee', predicate: AWARD_OLIVIER_NOMINEE },
      { id: 'drama-desk', label: 'Drama Desk winner', predicate: AWARD_DRAMA_DESK_WINNER },
    ],
  },
  {
    kind: 'multi',
    paramKey: 'genre',
    label: 'Genre & format',
    options: [
      { id: 'comedy', label: 'Comedy', predicate: GENRE_COMEDY },
      { id: 'drama', label: 'Drama', predicate: GENRE_DRAMA },
      { id: 'jukebox', label: 'Jukebox', predicate: FORMAT_JUKEBOX },
      { id: 'based-on-book', label: 'Based on book', predicate: SOURCE_BASED_ON_BOOK },
      { id: 'based-on-true-story', label: 'Based on true story', predicate: SOURCE_BASED_ON_TRUE_STORY },
      { id: 'film-adaptation', label: 'Film adaptation', predicate: SOURCE_FILM_ADAPTATION },
      { id: 'disney', label: 'Disney', predicate: SOURCE_DISNEY },
    ],
  },
  {
    kind: 'multi',
    paramKey: 'tickets',
    label: 'Tickets & access',
    options: [
      { id: 'lottery', label: 'Has lottery', predicate: TICKETS_LOTTERY },
      { id: 'rush', label: 'Has rush', predicate: TICKETS_RUSH },
    ],
  },
];

// ─────────────── Single-select groups (mirror inline ToggleBars) ───────────────

/**
 * Type group — identical across all 4 list pages. Defaults to 'all'.
 * Mirrors the inline Musical/Plays pill row.
 */
export const TYPE_GROUP: SingleGroupConfig = {
  kind: 'single',
  paramKey: 'type',
  label: 'Type',
  defaultValue: 'all',
  options: [
    { id: 'all', label: 'All' },
    { id: 'musical', label: 'Musicals' },
    { id: 'play', label: 'Plays' },
  ],
};

/** Broadway status options (CLOSING, no PREVIEWS). */
export const STATUS_OPTIONS_BROADWAY: SingleOption[] = [
  { id: 'now_playing', label: 'Playing' },
  { id: 'closing_soon', label: 'Closing' },
  { id: 'all', label: 'All' },
  { id: 'closed', label: 'Closed' },
];

/** Off-Broadway / West End / Off-West-End status options (PREVIEWS, no CLOSING). */
export const STATUS_OPTIONS_WITH_PREVIEWS: SingleOption[] = [
  { id: 'now_playing', label: 'Playing' },
  { id: 'previews', label: 'Previews' },
  { id: 'all', label: 'All' },
  { id: 'closed', label: 'Closed' },
];

/** Build a per-page Status SingleGroup from the page's status options. */
export function buildStatusGroup(options: SingleOption[]): SingleGroupConfig {
  return {
    kind: 'single',
    paramKey: 'status',
    label: 'Status',
    defaultValue: 'now_playing',
    options,
  };
}

/** Static list of param keys owned by single-select panel members. */
const SINGLE_PARAM_KEY_LIST = ['type', 'status'] as const;
export const SINGLE_PARAM_KEYS: ReadonlySet<string> = new Set(SINGLE_PARAM_KEY_LIST);

/** All param keys owned by the panel — used to scope Reset / Clear-all */
export const PANEL_PARAM_KEYS: ReadonlySet<string> = new Set([
  ...FILTER_GROUPS.map((g) => g.paramKey),
  ...SINGLE_PARAM_KEY_LIST,
  'dates', // time-period date ranges (multi)
]);

/** Look up a multi-select option by paramKey + id */
export function findFilterOption(paramKey: string, id: string): FilterOption | undefined {
  const group = FILTER_GROUPS.find((g) => g.paramKey === paramKey);
  return group?.options.find((o) => o.id === id);
}

/** Look up a single-select option by group + id */
export function findSingleOption(group: SingleGroupConfig, id: string): SingleOption | undefined {
  return group.options.find((o) => o.id === id);
}
