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
import {
  DEFAULT_GOLD_THRESHOLD,
  RECOMMENDED_MIN,
  WORTH_SEEING_MIN,
  MIXED_MIN,
  SCORE_TIER_LABELS,
} from '../../../scripts/lib/score-tiers';
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
  /**
   * When true, this option is rendered in the Advanced Filter panel only on
   * the dedicated brand domain that surfaces it (e.g. opera → operascorecard.com).
   * Hidden from the inline ToggleBar pill row everywhere AND from the panel on
   * other domains. Use for show-type niches that have small audiences and
   * would otherwise clutter the inline pill row for users who don't care.
   */
  advancedOnly?: boolean;
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

/**
 * Score tier pills with their ranges, from scripts/lib/score-tiers.js. Gold
 * (and the top of Recommended) moves with the market: London critics' Gold
 * starts at 85, so the West End pages pass that threshold.
 */
export function scoreTierOptions(goldThreshold: number = DEFAULT_GOLD_THRESHOLD): FilterOption[] {
  return [
    { id: 'critical-gold', label: `${SCORE_TIER_LABELS['must-see']} (${goldThreshold}+)`, predicate: SCORE_TIER_CRITICAL_GOLD },
    { id: 'recommended', label: `${SCORE_TIER_LABELS.recommended} (${RECOMMENDED_MIN}–${goldThreshold - 1})`, predicate: SCORE_TIER_RECOMMENDED },
    { id: 'worth-seeing', label: `${SCORE_TIER_LABELS['worth-seeing']} (${WORTH_SEEING_MIN}–${RECOMMENDED_MIN - 1})`, predicate: SCORE_TIER_WORTH_SEEING },
    { id: 'skippable', label: `${SCORE_TIER_LABELS.skippable} (${MIXED_MIN}–${WORTH_SEEING_MIN - 1})`, predicate: SCORE_TIER_SKIPPABLE },
    { id: 'critical-miss', label: `${SCORE_TIER_LABELS['stay-away']} (<${MIXED_MIN})`, predicate: SCORE_TIER_CRITICAL_MISS },
  ];
}

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
    options: scoreTierOptions(),
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
    // 2026-05-01 — opera surfaces only via Advanced Filter on operascorecard.com.
    // FilterPanel hides advancedOnly options when the host doesn't match. Met
    // opera coverage is small enough that adding it to the inline pill row on
    // broadwayscorecard.com would clutter the 99% case (Musicals / Plays).
    { id: 'opera', label: 'Opera', advancedOnly: true },
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

/** FILTER_GROUPS with the score tier labels for a Gold threshold (see scoreTierOptions). */
export function filterGroupsFor(goldThreshold: number = DEFAULT_GOLD_THRESHOLD): MultiGroupConfig[] {
  if (goldThreshold === DEFAULT_GOLD_THRESHOLD) return FILTER_GROUPS;
  return FILTER_GROUPS.map((g) =>
    g.paramKey === 'score_tier' ? { ...g, options: scoreTierOptions(goldThreshold) } : g,
  );
}

/** Look up a multi-select option by paramKey + id */
export function findFilterOption(
  paramKey: string,
  id: string,
  groups: MultiGroupConfig[] = FILTER_GROUPS,
): FilterOption | undefined {
  const group = groups.find((g) => g.paramKey === paramKey);
  return group?.options.find((o) => o.id === id);
}

/** Look up a single-select option by group + id */
export function findSingleOption(group: SingleGroupConfig, id: string): SingleOption | undefined {
  return group.options.find((o) => o.id === id);
}
