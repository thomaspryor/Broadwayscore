/**
 * Venue classification for London theatres.
 * Single source of truth: data/west-end-venues.json
 *
 * West End = SOLT member theatres / Theatreland.
 * Off-West End = everything else in London.
 */

const path = require('path');
const venueList = require(path.join(__dirname, '../../data/west-end-venues.json'));

const WEST_END_VENUES = new Set(venueList);

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
  /broadway-musical-rev/i,
  /-broadway-/i,
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

module.exports = { isOffWestEndVenue, isWestEndVenue, isLondonMarket, getMarketPool, isUkOutletUrl, isBroadwayUrl, BROADWAY_URL_PATTERNS, US_ONLY_OUTLET_IDS, normalizeVenueName, WEST_END_VENUES };
