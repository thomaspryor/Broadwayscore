/**
 * Venue classification for NYC + London theatres.
 *
 * West End = SOLT member theatres / Theatreland. Source: data/west-end-venues.json
 * Off-West End = everything else in London.
 * Known Off-Broadway venues: data/off-broadway-venues.json — used as a fallback
 *   when TodayTix omits the "Off Broadway" subcategory tag (it mis-tags shows;
 *   Broken Snow at Theatre 71 slipped through and needed a manual add, 2026-05-27).
 *
 * Both venue lists store ALREADY-NORMALIZED names (lowercase, trailing
 * "theatre"/"theater" + parentheticals stripped per normalizeVenueName).
 */

const path = require('path');
const venueList = require(path.join(__dirname, '../../data/west-end-venues.json'));
const obVenueList = require(path.join(__dirname, '../../data/off-broadway-venues.json'));

const WEST_END_VENUES = new Set(venueList);
const OFF_BROADWAY_VENUES = new Set(obVenueList);

function normalizeVenueName(venue) {
  if (!venue) return '';
  return venue.trim().toLowerCase()
    .replace(/[\u2018\u2019\u2032]/g, "'") // Normalize curly/prime apostrophes to straight
    .replace(/\s*\(.*\)$/, '')       // Strip parenthetical (e.g., "(National Theatre)")
    .replace(/ theatre$| theater$/, ''); // Strip trailing "Theatre"/"Theater"
}

function isOffWestEndVenue(venue) {
  if (!venue || venue === 'TBA') return false;
  return !WEST_END_VENUES.has(normalizeVenueName(venue));
}

function isWestEndVenue(venue) {
  if (!venue || venue === 'TBA') return false;
  return WEST_END_VENUES.has(normalizeVenueName(venue));
}

/**
 * True when a venue name matches a theatre we already classify as
 * Off-Broadway. Lets discovery rescue OB shows that TodayTix lists without
 * the "Off Broadway" subcategory tag. Accepts a string venue name or a
 * TodayTix-shape `{ name }` object.
 */
function isKnownOffBroadwayVenue(venue) {
  const name = typeof venue === 'string' ? venue : venue?.name;
  if (!name || name === 'TBA') return false;
  return OFF_BROADWAY_VENUES.has(normalizeVenueName(name));
}

// Non-traditional NYC venues large/prestigious enough that content-verifier's
// off-broadway prompt (wrongProdExamples: "Broadway production") makes an LLM
// treat their mere mention as proof of a wrong production — even though several
// are already catalogued here as category='off-broadway' (Park Avenue Armory,
// Carnegie Hall, NYU Skirball, New York City Center) or type='opera'
// (Metropolitan Opera House, already carved out separately). Found live via
// Les Misérables: The Arena Concert Spectacular @ Radio City Music Hall
// (2026-07-30): two correctly-attributed reviews were flagged wrongProduction
// with reasoning "Radio City Music Hall...is a Broadway venue, not an
// Off-Broadway venue". Substring match (not exact Set) since venue strings
// carry suffixes ("Stern Auditorium / Perelman Stage at Carnegie Hall").
const SPECIAL_ENGAGEMENT_VENUE_RE = /radio city music hall|park avenue armory|carnegie hall|nyu skirball|new york city center|metropolitan opera house/i;

function isSpecialEngagementVenue(venue) {
  if (!venue || venue === 'TBA') return false;
  return SPECIAL_ENGAGEMENT_VENUE_RE.test(venue);
}

/**
 * Get the market pool for a category. Shows within the same pool share a
 * browse page and must be deduplicated against each other.
 * Returns 'london' for west-end/off-west-end, 'nyc' for broadway/off-broadway.
 */
function getMarketPool(category) {
  const cat = category || 'broadway';
  if (cat === 'west-end' || cat === 'off-west-end') return 'london';
  return 'nyc';
}

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
function isLondonMarket(category) {
  return getMarketPool(category) === 'london';
}

/**
 * Broadway category predicate — mirrors src/lib/data-core.ts:64 for Node scripts.
 *
 * CONVENTION: null/undefined category counts as Broadway. ~1700 historical-import
 * shows (pre-2024) have null category because the creator scripts didn't stamp
 * it; the live site treats null as Broadway and this helper keeps scripts
 * consistent. Always use this predicate — never `s.category === 'broadway'`
 * directly, or you'll exclude ~94% of the historical Broadway corpus.
 */
function isBroadwayCategory(show) {
  if (!show) return false;
  return !show.category || show.category === 'broadway';
}

/** Off-Broadway category predicate. */
function isOffBroadwayCategory(show) {
  return !!show && show.category === 'off-broadway';
}

/**
 * Returns true if a URL belongs to a UK or major theatre outlet.
 * Used to prevent wrongShow false positives on London-market shows
 * reviewed by UK outlets.
 */
// US outlets whose hostnames contain 'theatre' — excluded from the UK hostname heuristic
const US_THEATRE_HOSTNAMES = new Set([
  'theatrely.com', 'www.theatrely.com',
  'musicaltheatrereview.com', 'www.musicaltheatrereview.com',
  'thefrontrowcenter.com', 'www.thefrontrowcenter.com',
  'nystagereview.com', 'www.nystagereview.com',
  'stageandcinema.com', 'www.stageandcinema.com',
]);

function isUkOutletUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname || '';
    // Exclude known US outlets before applying 'theatre' hostname heuristic
    if (US_THEATRE_HOSTNAMES.has(hostname)) return false;
    // Only match genuinely UK-specific outlet hostnames.
    // DO NOT include global/US outlets like variety, nytimes, timeout here —
    // they review both Broadway and West End shows.
    return hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk')
      || /london|theatre|whatsonstage|thestage|theguardian|telegraph|thetimes|independent|standard|inews/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Broadway URL patterns — used by ingestion guards and CI validation.
 * Matches URLs that are clearly about Broadway productions (not WE).
 */
const BROADWAY_URL_PATTERNS = [
  /\/newyork\//i,
  /\/new-york\//i,
  /newyork\.timeout\.com/i,
  /broadway-review/i,
  /broadway-theater-review/i,  // Added 2026-04-13 — caught Booth Theatre Les Liaisons Broadway transfer
  /broadway-theatre-review/i,  // UK spelling variant
  /broadway-musical-rev/i,
  /-broadway[\.\-\/]/i,
  /\/broadway\//i,
  /-on-broadway-/i,
  /opens-on-broadway/i,
];

/** US-only outlets that never review WE shows. Conservative list to avoid false positives. */
const US_ONLY_OUTLET_IDS = new Set([
  'nypost', 'nydailynews', 'chicagotribune', 'usatoday',
  'thewrap', 'cititour', 'sea-coast-online', 'press-herald',
]);

/**
 * Returns a reason string if the URL + outlet indicate a Broadway review,
 * or null if the URL appears legitimate for a WE show.
 */
function isBroadwayUrl(url, outletId) {
  if (!url) return null;
  const lowerUrl = url.toLowerCase();
  // US-only outlet
  if (outletId && US_ONLY_OUTLET_IDS.has(outletId.toLowerCase())) {
    return `US-only outlet "${outletId}" reviewing WE show`;
  }
  // Broadway URL patterns (exclude broadwayworld.com domain matches)
  for (const pat of BROADWAY_URL_PATTERNS) {
    if (pat.test(lowerUrl)) {
      if (lowerUrl.includes('broadwayworld.com') && !lowerUrl.includes('/broadway/')) continue;
      return `Broadway URL pattern: ${pat}`;
    }
  }
  return null;
}

/**
 * Generic venue tokens that match too many unrelated URLs to be useful as
 * disambiguation signals. These get stripped from venue-substring checks in
 * audit-cross-production.js AND market-routing.js's same-title branch.
 *
 * Examples of why each is "generic":
 *   - "broadway"  → matches every URL with /broadway/ in the path
 *   - "lyceum"    → London + NYC venues share the name; substring match wins
 *                   for whichever is listed first.
 *   - "apollo"    → London Apollo, Apollo Victoria, Apollo Harlem all exist.
 *
 * Stored as a Set for O(1) membership checks. Shared so both consumers update
 * together — if a new generic-overmatching venue is discovered (e.g. via a
 * cross-production audit FP), add it here once.
 */
const GENERIC_VENUE_SLUGS = new Set([
  // NYC-ish
  'broadway', 'lyceum', 'palace', 'majestic', 'imperial', 'studio-54',
  'music-box', 'belasco', 'circle-in-the-square',
  // West End generic-ish
  'apollo', 'criterion', 'duke-of-yorks', 'gielgud', 'lyric', 'phoenix',
  'piccadilly', 'savoy', 'vaudeville', 'victoria-palace',
]);

module.exports = { isOffWestEndVenue, isWestEndVenue, isKnownOffBroadwayVenue, isSpecialEngagementVenue, isLondonMarket, getMarketPool, isUkOutletUrl, isBroadwayUrl, isBroadwayCategory, isOffBroadwayCategory, BROADWAY_URL_PATTERNS, US_ONLY_OUTLET_IDS, normalizeVenueName, WEST_END_VENUES, OFF_BROADWAY_VENUES, GENERIC_VENUE_SLUGS };
