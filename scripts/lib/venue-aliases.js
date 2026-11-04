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

const { foldDiacritics } = require('./title-match');

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
  'Tom Stoppard Theatre': {
    region: 'london',
    aliases: ["Duke of York's Theatre"],
    note: 'Renamed 2026 for Tom Stoppard. Duke of York\'s Theatre until 2026 — reviews of the same run use either name (BRO-4956: Rent 2026).',
  },
  'Bush Theatre': {
    region: 'london',
    aliases: ['Holloway Theatre'],
    label: 'its main auditorium is the',
    note: 'The Holloway Theatre is the Bush Theatre\'s main house in Shepherd\'s Bush, not a different venue (BRO-4956: a Darkling review naming "the Holloway Theatre" was excluded as wrong production).',
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
 * Sub-stages inside a bigger building (BRO-6923). Critics name the building
 * ("at the Young Vic", "the National Theatre") while shows.json files the show
 * at the stage ("The Maria Theatre", "Lyttelton Theatre"), so a venue check
 * read the building name as a different production (Girls lost London Theatre,
 * Theatre Weekly and The Recs reviews; Inter Alia lost 9).
 *
 * Deliberately NOT part of VENUE_ALIASES: findCanonical() maps one name to ONE
 * canonical, and the National Theatre's three stages share a parent name, so a
 * reverse lookup of the parent must never pick a single stage (it returns the
 * whole stage list via stagesOfBuilding()). Every findCanonical consumer is
 * therefore unaffected.
 *
 * stageKeys are normalized substrings matched on word boundaries against the
 * shows.json venue string ("National Theatre (Olivier)", "The Other Palace -
 * Studio"). Soho Theatre Walthamstow is a separate site and has no key.
 */
const PARENT_BUILDINGS = [
  { parent: 'National Theatre', region: 'london',
    parentNames: ['National Theatre', 'Royal National Theatre'],
    stages: ['Lyttelton Theatre', 'Olivier Theatre', 'Dorfman Theatre'],
    stageKeys: ['lyttelton', 'olivier', 'dorfman', 'cottesloe'] },
  { parent: 'Young Vic', region: 'london',
    parentNames: ['Young Vic', 'Young Vic Theatre'],
    stages: ['The Maria', 'The Clare', 'Main House'],
    stageKeys: ['the maria', 'maria theatre', 'maria studio', 'the clare', 'clare theatre', 'clare studio', 'young vic main house', 'young vic (main house)'] },
  { parent: "Shakespeare's Globe", region: 'london',
    parentNames: ["Shakespeare's Globe", 'Shakespeares Globe'],
    stages: ['Sam Wanamaker Playhouse', "Shakespeare's Globe Theatre"],
    stageKeys: ['wanamaker'] },
  { parent: 'Hampstead Theatre', region: 'london',
    parentNames: ['Hampstead Theatre'],
    stages: ['Hampstead Theatre Downstairs', 'Hampstead Theatre Main Stage'],
    stageKeys: ['hampstead theatre downstairs', 'hampstead downstairs'] },
  { parent: 'Soho Theatre', region: 'london',
    parentNames: ['Soho Theatre'],
    stages: ['Soho Theatre Upstairs', 'Soho Theatre Downstairs'],
    stageKeys: ['soho theatre upstairs', 'soho theatre downstairs'] },
  { parent: 'The Other Palace', region: 'london',
    parentNames: ['The Other Palace', 'Other Palace'],
    stages: ['The Other Palace Studio', 'The Other Palace Main Auditorium'],
    stageKeys: ['other palace studio', 'other palace - studio', 'other palace main'] },
  { parent: 'Royal Court Theatre', region: 'london',
    parentNames: ['Royal Court Theatre', 'Royal Court'],
    stages: ['Jerwood Theatre Downstairs', 'Jerwood Theatre Upstairs'],
    stageKeys: ['jerwood theatre downstairs', 'jerwood theatre upstairs', 'royal court jerwood'] },
  // BRO-6945: NYC multi-stage buildings. Keys avoid bare generic words
  // ("newman", "stage 2", "griffin") that other NYC venues also use.
  { parent: 'Lincoln Center Theater', region: 'nyc',
    parentNames: ['Lincoln Center Theater', 'Lincoln Center'],
    stages: ['Vivian Beaumont Theater', 'Mitzi E. Newhouse Theater', 'Claire Tow Theater'],
    stageKeys: ['vivian beaumont', 'mitzi e. newhouse', 'mitzi e newhouse', 'newhouse theater', 'newhouse theatre', 'claire tow'] },
  { parent: 'The Public Theater', region: 'nyc',
    parentNames: ['The Public Theater', 'Public Theater', 'Joseph Papp Public Theater'],
    stages: ['Anspacher Theater', 'Newman Theater', 'Martinson Hall', 'LuEsther Hall', 'Shiva Theater', 'Barbaralee Theater', 'Delacorte Theater'],
    stageKeys: ['anspacher', 'luesther', 'martinson hall', 'martinson theater', 'shiva theater', 'barbaralee', 'delacorte', 'public theater/newman', 'public theater - newman', 'public theater newman'] },
  { parent: 'Pershing Square Signature Center', region: 'nyc',
    parentNames: ['Pershing Square Signature Center', 'The Pershing Square Signature Center', 'Signature Center', 'The Pershing Square Signature Theatre Center'],
    stages: ['Irene Diamond Stage', 'Alice Griffin Jewel Box Theater', 'Romulus Linney Courtyard Theater'],
    stageKeys: ['irene diamond', 'alice griffin', 'jewel box', 'romulus linney'] },
  { parent: 'Atlantic Theater Company', region: 'nyc',
    parentNames: ['Atlantic Theater Company', 'Atlantic Theater', 'Atlantic Theatre Company'],
    stages: ['Linda Gross Theater', 'Atlantic Stage 2'],
    stageKeys: ['linda gross', 'atlantic stage 2', 'atlantic theater company/stage 2', 'atlantic theater company - stage 2', 'atlantic theater company stage 2'] },
  { parent: 'Robert W. Wilson MCC Theater Space', region: 'nyc',
    parentNames: ['MCC Theater Space', 'Robert W. Wilson MCC Theater Space', 'The Robert W. Wilson MCC Theater Space', 'MCC Theater', 'MCC Theatre'],
    stages: ['Newman Mills Theater', 'Susan & Ronald Frankel Theater'],
    stageKeys: ['newman mills', 'ronald frankel', 'frankel theater'] },
  { parent: 'The Shed', region: 'nyc',
    parentNames: ['The Shed', 'Shed'],
    stages: ['The Griffin Theater', 'The Kenneth C. Griffin Theater'],
    stageKeys: ['griffin theater at the shed', 'griffin theatre at the shed', 'griffin at the shed', 'kenneth c. griffin theater', 'kenneth c griffin theater'] },
];

function _stageKeyMatches(normVenue, key) {
  const k = _normalize(key);
  const i = normVenue.indexOf(k);
  if (i < 0) return false;
  const before = i === 0 ? ' ' : normVenue[i - 1];
  const after = i + k.length >= normVenue.length ? ' ' : normVenue[i + k.length];
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

// "Dorfman (Cottesloe)" must not list "Dorfman Theatre" as an OTHER stage.
function _stageCore(x) {
  return _normalize(x).replace(/\b(the|theatre)\b/g, ' ').replace(/[()-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _regionOk(entry, market) {
  const region = _marketToRegion(market);
  return !region || !entry.region || entry.region === region;
}

/**
 * If `venue` is a stage inside a bigger building, return that building.
 * Returns null for the building itself and for unrelated venues.
 * @returns {{ parent: string, parentNames: string[], stages: string[] } | null}
 */
function parentBuildingOf(venue, market) {
  if (!venue) return null;
  const n = _normalize(venue);
  for (const b of PARENT_BUILDINGS) {
    if (!_regionOk(b, market)) continue;
    if (b.parentNames.some((p) => _normalize(p) === n)) continue; // the building itself
    if (b.stageKeys.some((k) => _stageKeyMatches(n, k))) {
      return { parent: b.parent, parentNames: b.parentNames.slice(), stages: b.stages.slice() };
    }
  }
  return null;
}

/**
 * Reverse lookup: given a building name, return ALL its stages (never one).
 * Empty when `name` is not a known multi-stage building.
 */
function stagesOfBuilding(name, market) {
  if (!name) return [];
  const n = _normalize(name);
  for (const b of PARENT_BUILDINGS) {
    if (!_regionOk(b, market)) continue;
    if (b.parentNames.some((p) => _normalize(p) === n)) return b.stages.slice();
  }
  return [];
}

/**
 * Prompt text for a show filed at a stage (or at the building): tells the
 * verifier that a review naming the building is NOT a different venue.
 * Empty string when the venue is neither.
 */
function buildParentBuildingNote(venue, market) {
  const p = parentBuildingOf(venue, market);
  if (p) {
    return `${venue} is one stage inside ${p.parent} (other stages: ${p.stages.filter((s) => { const c = _stageCore(s); return !c || !_stageCore(venue).includes(c); }).join(', ')}). A review that names "${p.parent}" instead of the stage is NOT by itself evidence of a different venue or production; still check the title, cast and dates`;
  }
  const stages = stagesOfBuilding(venue, market);
  if (stages.length) {
    return `${venue} is a building with several stages (${stages.join(', ')}); a review naming any one stage is NOT by itself evidence of a different production, but the same title can run on different stages as separate productions, so check the title, cast and dates`;
  }
  return '';
}

/**
 * Map a shows.json market/category value to an alias region.
 * 'west-end' / 'off-west-end' → 'london'; 'broadway' / 'off-broadway' → 'nyc'.
 * ABSENT market → null → no region filtering (legacy market-less callers).
 * Present-but-unmapped market (e.g. 'regional') → 'other' → matches NO
 * region-tagged entry (fail closed): a regional show at some other city's
 * "Lyric Theatre" must not inherit Broadway rename history.
 */
function _marketToRegion(market) {
  if (!market) return null;
  const m = String(market).toLowerCase();
  if (m === 'west-end' || m === 'off-west-end') return 'london';
  if (m === 'broadway' || m === 'off-broadway') return 'nyc';
  return 'other';
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
  if (entry) {
    const aliasList = entry.aliases.join(', ');
    return `${venue} (${entry.label || 'formerly known as:'} ${aliasList}. ${entry.note})`;
  }
  const buildingNote = buildParentBuildingNote(venue, market);
  if (buildingNote) return `${venue} (${buildingNote})`;
  // shows.json can carry the OLD name while reviews use the new one (Rent 2026
  // is filed at the Duke of York's, reviewed at the Tom Stoppard): name the
  // building's other names from the alias side too.
  const hit = _entryForAnyName(venue, market);
  if (!hit) return venue;
  return `${venue} (same building as ${otherVenueNames(venue, market).join(', ')}. ${hit[1].note})`;
}

function _entryForAnyName(venue, market) {
  if (!venue) return null;
  const region = _marketToRegion(market);
  const n = _normalize(venue);
  for (const [canonical, e] of Object.entries(VENUE_ALIASES)) {
    if (region && e.region && e.region !== region) continue;
    if (_normalize(canonical) === n || e.aliases.some((a) => _normalize(a) === n)) return [canonical, e];
  }
  return null;
}

/**
 * Every OTHER name the building has (current name and aliases, minus the one
 * given), region-filtered by market. Empty when none are known.
 * @param {string} venue  any name of the venue
 * @param {string} [market]
 * @returns {string[]}
 */
function otherVenueNames(venue, market) {
  const hit = _entryForAnyName(venue, market);
  if (!hit) return [];
  const n = _normalize(venue);
  return [hit[0], ...hit[1].aliases].filter((x) => _normalize(x) !== n);
}

function _normalize(s) {
  // foldDiacritics so an accented rendering of a venue ("Théâtre Royal") still
  // resolves to its ASCII canonical/alias entry. Task #648.
  return foldDiacritics(s).toLowerCase()
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
  otherVenueNames,
  PARENT_BUILDINGS,
  parentBuildingOf,
  stagesOfBuilding,
  buildParentBuildingNote,
};
