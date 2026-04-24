/**
 * West End / London venue rename history.
 *
 * Content-verifier (LLM) and production-verifier both compare venue names
 * pulled from shows.json against what the review text says. When a venue
 * has been renamed, reviews published before the rename legitimately say
 * the OLD name — which looks to the LLM like a wrongProduction signal.
 *
 * Motivating case (WE long-runner CV hardening card 34c637c5-416f-812b):
 *   Phantom WE shows.json venue = "His Majesty's Theatre" (renamed Sept 2022).
 *   Every pre-2022 review says "Her Majesty's Theatre". CV flagged them all.
 *
 * Usage:
 *   const { getVenueAliases, buildVenueContext } = require('./venue-aliases');
 *   buildVenueContext("His Majesty's Theatre")
 *     → "His Majesty's Theatre (formerly Her Majesty's Theatre until Sept 2022)"
 *
 * Keep this list curated — don't add every near-miss. Only rename events
 * that produce actual review-text mismatches belong here.
 */

/**
 * Each entry: canonical current name → { aliases: [...prior names...], note: "...context..." }
 * Aliases are ALSO canonical-name-searchable (see findCanonical).
 */
const VENUE_ALIASES = {
  "His Majesty's Theatre": {
    aliases: ["Her Majesty's Theatre"],
    note: 'Renamed Sept 2022 after the death of Elizabeth II. Phantom of the Opera ran continuously here since 1986 — pre-2022 reviews correctly say "Her Majesty\'s".',
  },
  'Sondheim Theatre': {
    aliases: ["Queen's Theatre"],
    note: 'Renamed Dec 2019 for Stephen Sondheim\'s 90th birthday. Les Misérables transferred here 2004 from Palace — 2004-2019 reviews correctly say "Queen\'s Theatre".',
  },
  'Gielgud Theatre': {
    aliases: ['Globe Theatre'],
    note: 'Renamed Oct 1994 for John Gielgud\'s 90th birthday (to avoid confusion with Shakespeare\'s Globe).',
  },
  'Gillian Lynne Theatre': {
    aliases: ['New London Theatre'],
    note: 'Renamed May 2018 for choreographer Gillian Lynne. Cats famously ran here 1981-2002.',
  },
  'Noël Coward Theatre': {
    aliases: ['Albery Theatre'],
    note: 'Renamed June 2006 from Albery Theatre (itself renamed from New Theatre in 1973).',
  },
  'Novello Theatre': {
    aliases: ['Strand Theatre', 'Waldorf Theatre', 'Whitney Theatre'],
    note: 'Renamed 2005 for Ivor Novello. Strand since 1913, briefly Waldorf and Whitney in earlier decades.',
  },
  'Harold Pinter Theatre': {
    aliases: ['Comedy Theatre'],
    note: 'Renamed 2011 after Harold Pinter.',
  },
  'Trafalgar Theatre': {
    aliases: ['Trafalgar Studios', 'Whitehall Theatre'],
    note: 'Whitehall until 2004, then Trafalgar Studios; restored to single auditorium as Trafalgar Theatre in 2021.',
  },
  '@sohoplace': {
    aliases: ['Soho Place'],
    note: 'Official styling is lowercase with @ prefix; "Soho Place" is the plain-text form reviewers use.',
  },
};

/** All alias strings in a flat set for quick lookup. */
const _ALIAS_SET = new Set();
for (const entry of Object.values(VENUE_ALIASES)) {
  for (const alias of entry.aliases) _ALIAS_SET.add(_normalize(alias));
}

/**
 * Look up aliases for a venue by its current canonical name.
 *
 * @param {string} venue — canonical (current) venue name
 * @returns {{ aliases: string[], note: string } | null}
 */
function getVenueAliases(venue) {
  if (!venue) return null;
  const entry = VENUE_ALIASES[venue];
  if (entry) return entry;
  // Also try case-insensitive lookup for data-entry variations
  const n = _normalize(venue);
  for (const [canonical, e] of Object.entries(VENUE_ALIASES)) {
    if (_normalize(canonical) === n) return e;
  }
  return null;
}

/**
 * Given ANY venue name (current or historical), return the current canonical
 * name. Returns the input unchanged if no alias is found.
 *
 * @param {string} venue
 * @returns {string}
 */
function findCanonical(venue) {
  if (!venue) return venue;
  const n = _normalize(venue);
  for (const [canonical, entry] of Object.entries(VENUE_ALIASES)) {
    if (_normalize(canonical) === n) return canonical;
    if (entry.aliases.some((a) => _normalize(a) === n)) return canonical;
  }
  return venue;
}

/**
 * Check whether a venue name is known to have historical aliases.
 * Useful for callers that want to know whether to pass extra context to an LLM.
 */
function hasAliases(venue) {
  return !!getVenueAliases(venue);
}

/**
 * Build an expanded venue-context string for LLM prompts. When the venue
 * has known aliases, append them + the rename note so the LLM doesn't
 * flag pre-rename reviews as wrongProduction.
 *
 * @param {string} venue  canonical venue name from shows.json
 * @returns {string}      expanded string safe to drop into a prompt
 */
function buildVenueContext(venue) {
  if (!venue) return '';
  const entry = getVenueAliases(venue);
  if (!entry) return venue;
  const aliasList = entry.aliases.join(', ');
  return `${venue} (formerly known as: ${aliasList}. ${entry.note})`;
}

function _normalize(s) {
  return String(s).toLowerCase()
    .replace(/['‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  VENUE_ALIASES,
  getVenueAliases,
  findCanonical,
  hasAliases,
  buildVenueContext,
};
