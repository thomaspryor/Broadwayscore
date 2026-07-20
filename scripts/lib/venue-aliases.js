/**
 * West End / London + Broadway / NYC venue rename history.
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
 * Each entry: canonical current name → { aliases: [...prior names...], note: "...context...", region }
 * Aliases are ALSO canonical-name-searchable (see findCanonical).
 *
 * `region` ('london' | 'nyc') disambiguates same-name venues across markets —
 * Broadway's Lyric Theatre (W 42nd St, ex-Foxwoods/Hilton/Ford Center) must not
 * inject its rename history into a London Lyric (Shaftesbury Avenue) show's CV
 * prompt, and vice versa. Lookups WITHOUT a market still match every entry
 * (legacy behavior); lookups WITH a market skip entries from the other region.
 */
const VENUE_ALIASES = {
  // ── West End / London ────────────────────────────────────────────────────
  "His Majesty's Theatre": {
    region: 'london',
    aliases: ["Her Majesty's Theatre"],
    note: 'Renamed Sept 2022 after the death of Elizabeth II. Phantom of the Opera ran continuously here since 1986 — pre-2022 reviews correctly say "Her Majesty\'s".',
  },
  'Sondheim Theatre': {
    region: 'london',
    aliases: ["Queen's Theatre"],
    note: 'Renamed Dec 2019 for Stephen Sondheim\'s 90th birthday. Les Misérables transferred here 2004 from Palace — 2004-2019 reviews correctly say "Queen\'s Theatre".',
  },
  'Gielgud Theatre': {
    region: 'london',
    aliases: ['Globe Theatre'],
    note: 'Renamed Oct 1994 for John Gielgud\'s 90th birthday (to avoid confusion with Shakespeare\'s Globe).',
  },
  'Gillian Lynne Theatre': {
    region: 'london',
    aliases: ['New London Theatre'],
    note: 'Renamed May 2018 for choreographer Gillian Lynne. Cats famously ran here 1981-2002.',
  },
  'Noël Coward Theatre': {
    region: 'london',
    aliases: ['Albery Theatre'],
    note: 'Renamed June 2006 from Albery Theatre (itself renamed from New Theatre in 1973).',
  },
  'Novello Theatre': {
    region: 'london',
    aliases: ['Strand Theatre', 'Waldorf Theatre', 'Whitney Theatre'],
    note: 'Renamed 2005 for Ivor Novello. Strand since 1913, briefly Waldorf and Whitney in earlier decades.',
  },
  'Harold Pinter Theatre': {
    region: 'london',
    aliases: ['Comedy Theatre'],
    note: 'Renamed 2011 after Harold Pinter.',
  },
  'Trafalgar Theatre': {
    region: 'london',
    aliases: ['Trafalgar Studios', 'Whitehall Theatre'],
    note: 'Whitehall until 2004, then Trafalgar Studios; restored to single auditorium as Trafalgar Theatre in 2021.',
  },
  '@sohoplace': {
    region: 'london',
    aliases: ['Soho Place'],
    note: 'Official styling is lowercase with @ prefix; "Soho Place" is the plain-text form reviewers use.',
  },
  // ── Broadway / NYC ───────────────────────────────────────────────────────
  // The 11 renamed Broadway houses from broadway-theaters.js (.renamed field).
  // 333 shows.json entries carry the post-rename name for pre-rename runs
  // (venue-anachronism audit 2026-07-13), so era-accurate review texts looked
  // like wrongProduction signals — this suppressed ALL of king-hedley-ii-2001's
  // reviews (venue said "August Wilson", 2001 reviews say "Virginia").
  'James Earl Jones Theatre': {
    region: 'nyc',
    aliases: ['Cort Theatre'],
    note: 'Renamed Sept 2022 for James Earl Jones. Cort Theatre 1912-2022 — pre-2022 reviews correctly say "Cort".',
  },
  'Gerald Schoenfeld Theatre': {
    region: 'nyc',
    aliases: ['Plymouth Theatre'],
    note: 'Renamed May 2005. Plymouth Theatre 1917-2005 — pre-2005 reviews correctly say "Plymouth".',
  },
  'Bernard B. Jacobs Theatre': {
    region: 'nyc',
    aliases: ['Royale Theatre'],
    note: 'Renamed May 2005. Royale Theatre until 2005 — pre-2005 reviews correctly say "Royale".',
  },
  'Gershwin Theatre': {
    region: 'nyc',
    aliases: ['Uris Theatre'],
    note: 'Renamed June 1983. Uris Theatre 1972-1983 — pre-1983 reviews correctly say "Uris".',
  },
  'Lena Horne Theatre': {
    region: 'nyc',
    aliases: ['Brooks Atkinson Theatre', 'Mansfield Theatre'],
    note: 'Renamed Nov 2022 for Lena Horne. Brooks Atkinson Theatre 1960-2022, Mansfield Theatre 1926-1960 — pre-2022 reviews correctly say "Brooks Atkinson".',
  },
  'August Wilson Theatre': {
    region: 'nyc',
    aliases: ['Virginia Theatre', 'ANTA Theatre', 'ANTA Playhouse', 'Guild Theatre'],
    note: 'Renamed Oct 2005 for August Wilson. Virginia Theatre 1981-2005, ANTA Theatre 1950-1981, Guild Theatre 1925-1950 — e.g. 2001 reviews correctly say "Virginia".',
  },
  'Al Hirschfeld Theatre': {
    region: 'nyc',
    aliases: ['Martin Beck Theatre'],
    note: 'Renamed June 2003 for Al Hirschfeld. Martin Beck Theatre 1924-2003 — pre-2003 reviews correctly say "Martin Beck".',
  },
  'Stephen Sondheim Theatre': {
    region: 'nyc',
    aliases: ["Henry Miller's Theatre", 'Henry Miller Theatre'],
    note: 'Renamed Sept 2010 for Stephen Sondheim. Henry Miller\'s Theatre before that (rebuilt, reopened 2009). Distinct from London\'s Sondheim Theatre (formerly Queen\'s).',
  },
  'Todd Haimes Theatre': {
    region: 'nyc',
    aliases: ['American Airlines Theatre', 'Selwyn Theatre'],
    note: 'Renamed Sept 2023 for Todd Haimes. American Airlines Theatre 2000-2023, Selwyn Theatre before 2000 — Roundabout\'s Broadway house; pre-2023 reviews correctly say "American Airlines".',
  },
  'Samuel J. Friedman Theatre': {
    region: 'nyc',
    aliases: ['Biltmore Theatre'],
    note: 'Renamed June 2008. Biltmore Theatre 1925-2008 — MTC\'s Broadway house; pre-2008 reviews correctly say "Biltmore".',
  },
  'Lyric Theatre': {
    region: 'nyc',
    aliases: ['Foxwoods Theatre', 'Hilton Theatre', 'Ford Center for the Performing Arts'],
    note: 'Broadway\'s Lyric on W 42nd St: Ford Center for the Performing Arts 1998-2005, Hilton Theatre 2005-2010, Foxwoods Theatre 2010-2014, Lyric since 2014. Distinct from London\'s Lyric Theatre on Shaftesbury Avenue.',
  },
};

/**
 * Map a shows.json market/category value to an alias region.
 * 'west-end' / 'off-west-end' → 'london'; 'broadway' / 'off-broadway' → 'nyc'.
 * Unknown/absent markets return null → no region filtering (legacy behavior).
 */
function _marketToRegion(market) {
  if (!market) return null;
  const m = String(market).toLowerCase();
  if (m === 'west-end' || m === 'off-west-end') return 'london';
  if (m === 'broadway' || m === 'off-broadway') return 'nyc';
  return null;
}

/** All alias strings in a flat set for quick lookup. */
const _ALIAS_SET = new Set();
for (const entry of Object.values(VENUE_ALIASES)) {
  for (const alias of entry.aliases) _ALIAS_SET.add(_normalize(alias));
}

/**
 * Look up aliases for a venue by its current canonical name.
 *
 * @param {string} venue — canonical (current) venue name
 * @param {string} [market] — shows.json market ('broadway', 'west-end', ...).
 *   When provided, entries from the other region are skipped so same-name
 *   venues (e.g. the two Lyric Theatres) don't cross-contaminate. Omitting
 *   it matches every entry (legacy behavior).
 * @returns {{ aliases: string[], note: string, region?: string } | null}
 */
function getVenueAliases(venue, market) {
  if (!venue) return null;
  const region = _marketToRegion(market);
  const matches = (e) => !region || !e.region || e.region === region;
  const entry = VENUE_ALIASES[venue];
  if (entry && matches(entry)) return entry;
  // Also try case-insensitive lookup for data-entry variations
  const n = _normalize(venue);
  for (const [canonical, e] of Object.entries(VENUE_ALIASES)) {
    if (_normalize(canonical) === n && matches(e)) return e;
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
 * @param {string} [market]  shows.json market, for same-name cross-region
 *   disambiguation (see getVenueAliases)
 * @returns {string}      expanded string safe to drop into a prompt
 */
function buildVenueContext(venue, market) {
  if (!venue) return '';
  const entry = getVenueAliases(venue, market);
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
