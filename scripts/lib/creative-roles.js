'use strict';

/**
 * creative-roles.js — which show.creativeTeam roles put a person on a
 * /creative/<slug> page, and in which categories.
 *
 * Extracted verbatim from src/lib/data-creative.ts (which imports and
 * re-exports getCategoriesForRole, so the site and the scripts side share
 * ONE table) for the S7-T3 follow-up: scripts/build-slug-redirects.js has to
 * know, from shows.json alone, which creative-team names become unified
 * creative pages and in what order — the slug-collision rule
 * (scripts/lib/url-slug.js assignUniqueSlugs) numbers "Noël Coward" as
 * `noel-coward-2` only because "Noel Coward" reached `noel-coward` first —
 * and a second copy of this table would drift the moment a role is added.
 */

/** @typedef {'director'|'playwright'|'composer'|'lyricist'} CreativeCategory */

/** @type {Record<string, CreativeCategory[]>} */
const ROLE_TO_CATEGORIES = {
  // Director
  'Director': ['director'],
  'Directors': ['director'],
  // Playwright / Book
  'Playwright': ['playwright'],
  'Book': ['playwright'],
  'Written By': ['playwright'],
  'Writer': ['playwright'],
  'Book Writer': ['playwright'],
  // Composer
  'Music': ['composer'],
  'Composer': ['composer'],
  // Lyricist
  'Lyrics': ['lyricist'],
  'Lyricist': ['lyricist'],
  // Combined roles — appear in multiple categories
  'Music & Lyrics': ['composer', 'lyricist'],
  'Music & Lyrics (catalog)': ['composer', 'lyricist'],
  'Book & Lyrics': ['playwright', 'lyricist'],
  'Lyrics & Book': ['playwright', 'lyricist'],
  'Book, Music & Lyrics': ['playwright', 'composer', 'lyricist'],
  'Music, Lyrics & Book': ['playwright', 'composer', 'lyricist'],
  // Less common variants
  'Co-Writer': ['playwright'],
  'English Lyrics': ['lyricist'],
  'Co-Director': ['director'],
  'Book Writers': ['playwright'],
};

// Roles to exclude even if they contain "Director" (checked lowercase — the LLM
// pipeline emits arbitrary case, see ROLE_TO_CATEGORIES_LOWER below)
const EXCLUDED_DIRECTOR_ROLES = new Set([
  'music director', 'music direction', 'artistic director',
  'associate director', 'resident director',
]);

// Build a lowercase lookup so case-drift ("Book writer" vs "Book Writer") still maps.
// Auto-fix-show-data.js writes whatever case the LLM emitted — data already has 37
// entries with lowercase "Book writer" that the exact-case map silently dropped.
/** @type {Record<string, CreativeCategory[]>} */
const ROLE_TO_CATEGORIES_LOWER = {};
for (const [k, v] of Object.entries(ROLE_TO_CATEGORIES)) {
  ROLE_TO_CATEGORIES_LOWER[k.toLowerCase()] = v;
}

/**
 * The page categories a creative-team role maps to ([] = no creative page).
 * @param {string} role
 * @returns {CreativeCategory[]}
 */
function getCategoriesForRole(role) {
  // Direct match first (preserves any case-sensitive lookup callers may rely on)
  if (ROLE_TO_CATEGORIES[role]) return ROLE_TO_CATEGORIES[role];

  // Case-insensitive match next
  const lowerMatch = ROLE_TO_CATEGORIES_LOWER[role.toLowerCase()];
  if (lowerMatch) return lowerMatch;

  const roleLower = role.toLowerCase();
  if (EXCLUDED_DIRECTOR_ROLES.has(roleLower)) return [];

  // Compound roles: split on comma/ampersand/slash/"and" and map each part.
  // Handles "Director & Choreographer", "Book, Music, and Lyrics", "Composer/Lyricist",
  // "Book & Director" — the unmatched parts (Choreographer, Sound Design, …) drop out.
  // Multi-word parts like "Music Direction" or "Sound Design" stay whole and simply
  // don't match, so excluded roles can't leak in through splitting.
  const parts = role.split(/\s*(?:[,&/]|\band\b)\s*/i).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    // Music-context guard: in "Music Supervisor & Director"-style credits the
    // "Director" part is the music department's, not the show's stage director.
    const isMusicContext = roleLower.includes('music');
    /** @type {Set<CreativeCategory>} */
    const cats = new Set();
    for (const part of parts) {
      if (EXCLUDED_DIRECTOR_ROLES.has(part.toLowerCase())) continue;
      const mapped = ROLE_TO_CATEGORIES_LOWER[part.toLowerCase()];
      if (mapped) mapped.forEach(c => { if (!(c === 'director' && isMusicContext)) cats.add(c); });
    }
    if (cats.size > 0) return Array.from(cats);
  }

  return [];
}

module.exports = { ROLE_TO_CATEGORIES, EXCLUDED_DIRECTOR_ROLES, getCategoriesForRole };
