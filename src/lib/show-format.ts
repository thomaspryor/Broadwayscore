/**
 * Show format labels — single source of truth for turning `show.type` into a
 * human label.
 *
 * Why this file exists: `type` was historically rendered by hand-rolled
 * `type === 'musical' ? 'Musical' : 'Play'` ternaries scattered across the web
 * app, the email templates and the newsletter generator. Every one of them
 * treated "not a musical" as "a play", so when `type: 'special'` entered the
 * corpus, 43 shows — concerts, galas, immersive experiences, dance and cabaret
 * — silently rendered as PLAY. The live example that surfaced it was the
 * Les Misérables Arena Concert at Radio City, badged "PLAY" on 2026-07-30.
 *
 * The rule: every value in KNOWN_SHOW_TYPES must have an explicit entry here.
 * There is deliberately NO silent fallback to 'play' —
 * tests/unit/show-format-coverage.test.mjs fails if data/shows.json ever grows
 * a type this map does not handle, so the next new type is caught in CI rather
 * than on a live show page.
 *
 * scripts/lib/show-format.js is the CommonJS mirror for the email/newsletter
 * codebase (which cannot import from src/). The same test asserts the two stay
 * in sync — same pattern as src/lib/genre.ts <-> scripts/lib/genre-classification.js.
 *
 * Note on 'special': it covers concerts, galas, immersive experiences, cabaret
 * and dance — anything that is neither a play nor a musical nor an opera. It is
 * labelled EVENT rather than CONCERT because the set is broader than concerts
 * (Magic Mike Live, The Traitors Live Experience, Be Like Blippi). Shows with a
 * more specific `genre` additionally render a GenrePill (see src/lib/genre.ts);
 * this pill answers "what kind of production", the genre pill answers "what
 * kind of performance".
 */

export interface ShowFormat {
  /** Uppercase pill label, e.g. 'MUSICAL'. */
  label: string;
  /** Title-case inline label, e.g. 'Musical' — for prose and email rows. */
  title: string;
  /** Tailwind border+text classes for the outline pill. */
  colorClass: string;
  /** Tailwind text colour alone, for the borderless mobile pill row. */
  textClass: string;
  /** Hex text colour for HTML email, which cannot use Tailwind. */
  emailColor: string;
}

/**
 * Every `type` value that may appear in data/shows.json.
 * Adding a value here without adding it to SHOW_FORMATS is a type error.
 */
export const KNOWN_SHOW_TYPES = ['musical', 'play', 'opera', 'special'] as const;

export type ShowType = (typeof KNOWN_SHOW_TYPES)[number];

/**
 * Opera colour is indigo, chosen to avoid collision with the score-tier reds
 * and the musical-purple / play-blue palette. Special is amber, matching the
 * amber convention already used by GenrePill for non-theatrical performances.
 */
export const SHOW_FORMATS: Record<ShowType, ShowFormat> = {
  musical: {
    label: 'MUSICAL',
    title: 'Musical',
    colorClass: 'border-purple-500/50 text-purple-400',
    textClass: 'text-purple-400',
    emailColor: '#a78bfa',
  },
  play: {
    label: 'PLAY',
    title: 'Play',
    colorClass: 'border-blue-500/50 text-blue-400',
    textClass: 'text-blue-400',
    emailColor: '#60a5fa',
  },
  opera: {
    label: 'OPERA',
    title: 'Opera',
    colorClass: 'border-indigo-500/50 text-indigo-400',
    textClass: 'text-indigo-400',
    emailColor: '#818cf8',
  },
  special: {
    label: 'EVENT',
    title: 'Event',
    colorClass: 'border-amber-500/50 text-amber-400',
    textClass: 'text-amber-400',
    emailColor: '#fbbf24',
  },
};

/** Fallback used only for genuinely unknown input (null/undefined/typo). */
const UNKNOWN_FORMAT: ShowFormat = {
  label: 'EVENT',
  title: 'Event',
  colorClass: 'border-white/10 text-gray-400',
  textClass: 'text-gray-400',
  emailColor: '#9ca3af',
};

/**
 * Resolve a show's format for display.
 *
 * Unknown types resolve to a neutral EVENT rather than PLAY: mislabelling a
 * concert as a play is a factual error a reader will notice, while EVENT is
 * merely unspecific. Known types must be in SHOW_FORMATS — the coverage test
 * guarantees the corpus never relies on this fallback.
 */
export function resolveShowFormat(type?: string | null): ShowFormat {
  if (!type) return UNKNOWN_FORMAT;
  return SHOW_FORMATS[type as ShowType] ?? UNKNOWN_FORMAT;
}

/** Uppercase pill label for a show type, e.g. 'MUSICAL'. */
export function showFormatLabel(type?: string | null): string {
  return resolveShowFormat(type).label;
}

/** Title-case inline label for a show type, e.g. 'Musical'. */
export function showFormatTitle(type?: string | null): string {
  return resolveShowFormat(type).title;
}

/** Tailwind text-colour class alone, for the borderless mobile pill row. */
export function showFormatTextClass(type?: string | null): string {
  return resolveShowFormat(type).textClass;
}
