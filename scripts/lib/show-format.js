/**
 * Show format labels — CommonJS mirror of src/lib/show-format.ts.
 *
 * The email templates, the opening-night broadcast and the newsletter generator
 * live outside the Next.js app and cannot import from src/, so the label map is
 * duplicated here. tests/unit/show-format-coverage.test.mjs asserts the two
 * copies stay in sync and that both cover every `type` present in
 * data/shows.json — the same parity pattern used by src/lib/genre.ts and
 * scripts/lib/genre-classification.js.
 *
 * Background: every consumer used to hand-roll `type === 'musical' ? 'Musical'
 * : 'Play'`, so `type: 'special'` (43 shows — concerts, galas, immersive
 * experiences, cabaret, dance) silently rendered as PLAY. The Les Misérables
 * Arena Concert at Radio City shipped labelled "PLAY" on 2026-07-30, including
 * in digest email.
 *
 * If you add a format here, add it to src/lib/show-format.ts too — the test
 * fails otherwise.
 */

/** Every `type` value that may appear in data/shows.json. */
const KNOWN_SHOW_TYPES = ['musical', 'play', 'opera', 'special'];

const SHOW_FORMATS = {
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

/** Fallback for genuinely unknown input — neutral, never 'PLAY'. */
const UNKNOWN_FORMAT = {
  label: 'EVENT',
  title: 'Event',
  colorClass: 'border-gray-500/50 text-gray-400',
  textClass: 'text-gray-400',
  emailColor: '#9ca3af',
};

/**
 * Resolve a show's format for display. Unknown types resolve to a neutral
 * EVENT rather than PLAY — calling a concert a play is a factual error a reader
 * notices; EVENT is merely unspecific.
 */
function resolveShowFormat(type) {
  if (!type) return UNKNOWN_FORMAT;
  return SHOW_FORMATS[type] || UNKNOWN_FORMAT;
}

/** Uppercase pill label, e.g. 'MUSICAL'. */
function showFormatLabel(type) {
  return resolveShowFormat(type).label;
}

/** Title-case inline label, e.g. 'Musical'. */
function showFormatTitle(type) {
  return resolveShowFormat(type).title;
}

module.exports = {
  KNOWN_SHOW_TYPES,
  SHOW_FORMATS,
  resolveShowFormat,
  showFormatLabel,
  showFormatTitle,
};
