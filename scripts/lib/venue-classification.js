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

/** Returns true for both 'west-end' and 'off-west-end' — i.e., any London market. */
function isLondonMarket(category) {
  return category === 'west-end' || category === 'off-west-end';
}

/**
 * Returns true if a URL belongs to a UK or major theatre outlet.
 * Used to prevent wrongShow false positives on London-market shows
 * reviewed by UK outlets.
 */
function isUkOutletUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname || '';
    return hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk')
      || /london|theatre|whatsonstage|thestage|theguardian|telegraph|thetimes|independent|standard|inews|variety|nytimes|timeout/.test(hostname);
  } catch {
    return false;
  }
}

module.exports = { isOffWestEndVenue, isWestEndVenue, isLondonMarket, isUkOutletUrl, normalizeVenueName, WEST_END_VENUES };
