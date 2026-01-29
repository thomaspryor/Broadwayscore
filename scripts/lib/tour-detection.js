/**
 * Tour Detection Module
 *
 * Prevents national tours and non-Broadway productions from being
 * added to the database. Only official Broadway productions should
 * be included.
 */

const { isOfficialBroadwayTheater } = require('./broadway-theaters');

/**
 * Patterns in titles that indicate a touring production
 */
const TOUR_TITLE_PATTERNS = [
  /national\s+tour/i,
  /touring\s+production/i,
  /touring\s+company/i,
  /first\s+national/i,
  /north\s+american\s+tour/i,
  /u\.?s\.?\s+tour/i,
  /\btour\b(?!\s*(de|du|des)\b)/i, // "tour" but not French words
  /on\s+tour/i,
  /\btroupe\b/i,
  /road\s+(company|production)/i,
  /bus\s+and\s+truck/i,
  /sit[-\s]down\s+production/i,
];

/**
 * Known touring venues (NOT Broadway theaters)
 * These are major venues that tours play but are NOT on Broadway
 */
const TOURING_VENUES = [
  // Los Angeles
  'ahmanson theatre',
  'pantages theatre',
  'hollywood pantages',
  'dolby theatre',
  'segerstrom center',
  'la mirada theatre',

  // San Francisco Bay Area
  'curran theatre',
  'orpheum theatre san francisco',
  'golden gate theatre',
  'shn orpheum',
  'shn golden gate',
  'shn curran',

  // Chicago (NOTE: "Nederlander Theatre" without "Chicago" is Broadway!)
  'cadillac palace theatre',
  'privatebank theatre',
  'bank of america theatre',
  'james m nederlander theatre chicago',
  'broadway in chicago',
  'cibc theatre',
  'nederlander theatre chicago',

  // Washington DC (NOTE: "National Theatre" alone could be Broadway Nederlander)
  'kennedy center',
  'national theatre washington',
  'national theatre dc',
  'warner theatre dc',

  // Boston
  'boston opera house',
  'citizens bank opera house',
  'boch center',

  // Philadelphia
  'academy of music',
  'forrest theatre philadelphia',
  'kimmel center',

  // Other Major Cities
  'fox theatre atlanta',
  'fox theatre detroit',
  'saenger theatre',
  'bass performance hall',
  'smith center',
  'buell theatre',
  'denver center',
  'segerstrom hall',
  'broward center',
  'kravis center',
  'straz center',
  'dr phillips center',
  'blumenthal performing arts',
  'belk theater',
  'dpac',
  'durham performing arts center',
  'ppac',
  'providence performing arts',
  'altria theater',
  'fox theatre st louis',
  'fabulous fox',
  'orpheum theatre minneapolis',
  'state theatre minneapolis',
  'hennepin theatre trust',
  'connor palace',
  'playhouse square',
  'ohio theatre',
  'benedum center',
  'music hall kansas city',
  'starlight theatre',
  'civic center music hall',

  // International
  'west end',
  'london',
  'toronto',
  'mirvish',
];

/**
 * Patterns that indicate Off-Broadway or Off-Off-Broadway
 */
const OFF_BROADWAY_PATTERNS = [
  /off[-\s]?broadway/i,
  /off[-\s]?off[-\s]?broadway/i,
  /o\.?b\.?/i, // O.B. abbreviation
];

/**
 * Known Off-Broadway venues
 */
const OFF_BROADWAY_VENUES = [
  'public theater',
  'the public',
  'new york theatre workshop',
  'nytw',
  'playwrights horizons',
  'atlantic theater',
  'signature theatre',
  'vineyard theatre',
  'mitzi newhouse',
  'claire tow',
  'ars nova',
  'st. anns warehouse',
  'st anns warehouse',
  'lucille lortel',
  'minetta lane',
  'cherry lane',
  'union square theatre',
  'new world stages',
  'stage 42',
  'daryl roth',
  'westside theatre',
  'the gym at judson',
  'barrow street theatre',
  'theatre row',
  'acorn theatre',
  'beckett theatre',
  'clurman theatre',
  'kirk theatre',
  'lion theatre',
];

/**
 * Check if a title indicates a touring production
 */
function titleIndicatesTour(title) {
  if (!title) return false;

  for (const pattern of TOUR_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a venue is a known touring venue (not Broadway)
 *
 * NOTE: This uses exact matching to avoid false positives like
 * "Nederlander Theatre" (Broadway) matching "Nederlander Theatre Chicago" (tour)
 */
function isKnownTouringVenue(venueName) {
  if (!venueName) return false;

  const normalized = venueName.toLowerCase().trim();

  for (const tourVenue of TOURING_VENUES) {
    // Exact match
    if (normalized === tourVenue) {
      return true;
    }
    // Tour venue is contained in normalized name (e.g., "ahmanson theatre los angeles" contains "ahmanson theatre")
    if (normalized.includes(tourVenue)) {
      return true;
    }
    // Don't do reverse check - it causes false positives
    // e.g., "nederlander theatre" is contained in "nederlander theatre chicago"
  }

  return false;
}

/**
 * Check if a venue is Off-Broadway
 */
function isOffBroadwayVenue(venueName) {
  if (!venueName) return false;

  const normalized = venueName.toLowerCase().trim();

  for (const venue of OFF_BROADWAY_VENUES) {
    if (normalized.includes(venue) || venue.includes(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if title or description indicates Off-Broadway
 */
function indicatesOffBroadway(text) {
  if (!text) return false;

  for (const pattern of OFF_BROADWAY_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Main function: Determine if a show is a tour (not Broadway)
 *
 * @param {Object} show - Show object with title and venue
 * @returns {{ isTour: boolean, reason?: string, type?: string }}
 */
function isTourProduction(show) {
  const { title, venue, description } = show;

  // 1. Check if title explicitly says "tour" - strongest signal
  if (titleIndicatesTour(title)) {
    return {
      isTour: true,
      reason: `Title "${title}" indicates touring production`,
      type: 'tour'
    };
  }

  // 2. Check if description/title indicates Off-Broadway
  if (indicatesOffBroadway(title) || indicatesOffBroadway(description)) {
    return {
      isTour: true,
      reason: 'Listed as Off-Broadway or Off-Off-Broadway',
      type: 'off-broadway'
    };
  }

  // 3. If venue is an OFFICIAL Broadway theater, it's definitely not a tour
  // This check comes BEFORE touring venue check to avoid false positives
  if (venue && isOfficialBroadwayTheater(venue)) {
    return { isTour: false };
  }

  // 4. Check if venue is a known touring venue
  if (isKnownTouringVenue(venue)) {
    return {
      isTour: true,
      reason: `Venue "${venue}" is a touring venue, not a Broadway theater`,
      type: 'tour'
    };
  }

  // 5. Check if venue is Off-Broadway
  if (isOffBroadwayVenue(venue)) {
    return {
      isTour: true,
      reason: `Venue "${venue}" is Off-Broadway`,
      type: 'off-broadway'
    };
  }

  // 6. Check if venue is NOT a recognized Broadway theater (unknown venue)
  if (venue && venue !== 'TBA') {
    return {
      isTour: true,
      reason: `Venue "${venue}" is not a recognized Broadway theater`,
      type: 'unknown-venue'
    };
  }

  // No venue specified or TBA - can't determine
  return { isTour: false };
}

/**
 * Validate that a show should be added to Broadway database
 *
 * @param {Object} show - Show to validate
 * @returns {{ isValid: boolean, issues: string[], warnings: string[] }}
 */
function validateBroadwayProduction(show) {
  const issues = [];
  const warnings = [];

  // Check for tour
  const tourCheck = isTourProduction(show);
  if (tourCheck.isTour) {
    issues.push(tourCheck.reason);
  }

  // Check venue
  if (!show.venue) {
    warnings.push('No venue specified');
  } else if (!isOfficialBroadwayTheater(show.venue)) {
    // Already handled by isTourProduction, but add warning if not an issue
    if (!tourCheck.isTour) {
      warnings.push(`Venue "${show.venue}" not in official Broadway theater list`);
    }
  }

  // Check for suspicious title patterns
  if (/\bconcert\b/i.test(show.title) && !/concert\s+version/i.test(show.title)) {
    warnings.push('Title contains "concert" - may be a concert event, not a show');
  }

  if (/\bgala\b/i.test(show.title)) {
    warnings.push('Title contains "gala" - may be a special event');
  }

  if (/\bbenefit\b/i.test(show.title)) {
    warnings.push('Title contains "benefit" - may be a benefit performance');
  }

  return {
    isValid: issues.length === 0,
    issues,
    warnings
  };
}

module.exports = {
  isTourProduction,
  validateBroadwayProduction,
  titleIndicatesTour,
  isKnownTouringVenue,
  isOffBroadwayVenue,
  TOURING_VENUES,
  OFF_BROADWAY_VENUES,
};
