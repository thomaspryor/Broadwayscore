/**
 * Single source of truth for panel filter UI metadata + predicate wiring.
 * The panel reads this to render groups; the hook reads it to apply
 * predicates against the show list.
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
  AWARD_PULITZER,
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
  FORMAT_CONCERT,
  FORMAT_SOLO_SHOW,
  FORMAT_IMMERSIVE,
  FORMAT_REVUE,
  SOURCE_BASED_ON_BOOK,
  SOURCE_BASED_ON_TRUE_STORY,
  SOURCE_FILM_ADAPTATION,
  SOURCE_DISNEY,
} from '@/lib/show-filter-predicates';

export interface FilterOption {
  /** Stable id — used in URL and as predicate key */
  id: string;
  label: string;
  predicate: FilterPredicate;
}

export interface FilterGroupConfig {
  /** URL param key (e.g. "production") — comma-separated multi-value */
  paramKey: string;
  label: string;
  options: FilterOption[];
}

export const FILTER_GROUPS: FilterGroupConfig[] = [
  {
    paramKey: 'production',
    label: 'Production',
    options: [
      { id: 'original', label: 'Original', predicate: PRODUCTION_ORIGINAL },
      { id: 'revival', label: 'Revival', predicate: PRODUCTION_REVIVAL },
    ],
  },
  {
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
    paramKey: 'awards',
    label: 'Awards',
    options: [
      { id: 'tony-winner', label: 'Tony winner', predicate: AWARD_TONY_WINNER },
      { id: 'tony-nominee', label: 'Tony nominee', predicate: AWARD_TONY_NOMINEE },
      { id: 'olivier-winner', label: 'Olivier winner', predicate: AWARD_OLIVIER_WINNER },
      { id: 'olivier-nominee', label: 'Olivier nominee', predicate: AWARD_OLIVIER_NOMINEE },
      { id: 'drama-desk', label: 'Drama Desk winner', predicate: AWARD_DRAMA_DESK_WINNER },
      { id: 'pulitzer', label: 'Pulitzer (Drama)', predicate: AWARD_PULITZER },
    ],
  },
  {
    paramKey: 'genre',
    label: 'Genre & format',
    options: [
      { id: 'comedy', label: 'Comedy', predicate: GENRE_COMEDY },
      { id: 'drama', label: 'Drama', predicate: GENRE_DRAMA },
      { id: 'jukebox', label: 'Jukebox', predicate: FORMAT_JUKEBOX },
      { id: 'concert', label: 'Concert', predicate: FORMAT_CONCERT },
      { id: 'solo-show', label: 'Solo show', predicate: FORMAT_SOLO_SHOW },
      { id: 'immersive', label: 'Immersive', predicate: FORMAT_IMMERSIVE },
      { id: 'revue', label: 'Revue', predicate: FORMAT_REVUE },
      { id: 'based-on-book', label: 'Based on book', predicate: SOURCE_BASED_ON_BOOK },
      { id: 'based-on-true-story', label: 'Based on true story', predicate: SOURCE_BASED_ON_TRUE_STORY },
      { id: 'film-adaptation', label: 'Film adaptation', predicate: SOURCE_FILM_ADAPTATION },
      { id: 'disney', label: 'Disney', predicate: SOURCE_DISNEY },
    ],
  },
  {
    paramKey: 'tickets',
    label: 'Tickets & access',
    options: [
      { id: 'lottery', label: 'Has lottery', predicate: TICKETS_LOTTERY },
      { id: 'rush', label: 'Has rush', predicate: TICKETS_RUSH },
    ],
  },
];

/** All param keys owned by the panel — used to scope Reset / Clear-all */
export const PANEL_PARAM_KEYS: ReadonlySet<string> = new Set([
  ...FILTER_GROUPS.map((g) => g.paramKey),
  'years', // time-period range (Sprint 3 — slider not yet shipped)
]);

/** Look up an option by paramKey + id */
export function findFilterOption(paramKey: string, id: string): FilterOption | undefined {
  const group = FILTER_GROUPS.find((g) => g.paramKey === paramKey);
  return group?.options.find((o) => o.id === id);
}
