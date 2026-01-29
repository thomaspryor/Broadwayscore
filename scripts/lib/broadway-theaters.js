/**
 * Broadway Theater Canonical List & Validation
 *
 * Official Broadway theaters are members of The Broadway League
 * and have 500+ seats in the Theater District.
 *
 * This module validates that venues are actual Broadway theaters,
 * preventing tours and Off-Broadway from being added.
 */

/**
 * Official Broadway Theaters (as of 2024-2025 season)
 * Organized by owner/operator
 */
const BROADWAY_THEATERS = {
  // === SHUBERT ORGANIZATION (17 theaters) ===
  'ambassador': {
    canonical: 'Ambassador Theatre',
    address: '219 W 49th St',
    seats: 1125,
    aliases: []
  },
  'booth': {
    canonical: 'Booth Theatre',
    address: '222 W 45th St',
    seats: 785,
    aliases: []
  },
  'broadhurst': {
    canonical: 'Broadhurst Theatre',
    address: '235 W 44th St',
    seats: 1186,
    aliases: []
  },
  'broadway': {
    canonical: 'Broadway Theatre',
    address: '1681 Broadway',
    seats: 1761,
    aliases: []
  },
  'cort': {
    canonical: 'James Earl Jones Theatre',
    address: '138 W 48th St',
    seats: 1084,
    aliases: ['Cort Theatre'],
    renamed: '2022-09-12'
  },
  'ethel-barrymore': {
    canonical: 'Ethel Barrymore Theatre',
    address: '243 W 47th St',
    seats: 1096,
    aliases: ['Barrymore Theatre']
  },
  'gerald-schoenfeld': {
    canonical: 'Gerald Schoenfeld Theatre',
    address: '236 W 45th St',
    seats: 1079,
    aliases: ['Schoenfeld Theatre', 'Plymouth Theatre'],
    renamed: '2005-05-09'
  },
  'golden': {
    canonical: 'John Golden Theatre',
    address: '252 W 45th St',
    seats: 805,
    aliases: ['Golden Theatre']
  },
  'imperial': {
    canonical: 'Imperial Theatre',
    address: '249 W 45th St',
    seats: 1417,
    aliases: []
  },
  'jacobs': {
    canonical: 'Bernard B. Jacobs Theatre',
    address: '242 W 45th St',
    seats: 1078,
    aliases: ['Jacobs Theatre', 'Royale Theatre'],
    renamed: '2005-05-09'
  },
  'longacre': {
    canonical: 'Longacre Theatre',
    address: '220 W 48th St',
    seats: 1091,
    aliases: []
  },
  'lyceum': {
    canonical: 'Lyceum Theatre',
    address: '149 W 45th St',
    seats: 922,
    aliases: []
  },
  'majestic': {
    canonical: 'Majestic Theatre',
    address: '245 W 44th St',
    seats: 1645,
    aliases: []
  },
  'music-box': {
    canonical: 'Music Box Theatre',
    address: '239 W 45th St',
    seats: 1009,
    aliases: []
  },
  'shubert': {
    canonical: 'Shubert Theatre',
    address: '225 W 44th St',
    seats: 1460,
    aliases: []
  },
  'winter-garden': {
    canonical: 'Winter Garden Theatre',
    address: '1634 Broadway',
    seats: 1526,
    aliases: []
  },

  // === NEDERLANDER ORGANIZATION (9 theaters) ===
  'brooks-atkinson': {
    canonical: 'Brooks Atkinson Theatre',
    address: '256 W 47th St',
    seats: 1069,
    aliases: ['Atkinson Theatre']
  },
  'gershwin': {
    canonical: 'Gershwin Theatre',
    address: '222 W 51st St',
    seats: 1933,
    aliases: []
  },
  'lena-horne': {
    canonical: 'Lena Horne Theatre',
    address: '256 W 47th St',
    seats: 1467,
    aliases: ['Brooks Atkinson Theatre'],
    renamed: '2022-11-01'
  },
  'lunt-fontanne': {
    canonical: 'Lunt-Fontanne Theatre',
    address: '205 W 46th St',
    seats: 1519,
    aliases: ['Lunt Fontanne']
  },
  'marquis': {
    canonical: 'Marquis Theatre',
    address: '1535 Broadway',
    seats: 1612,
    aliases: []
  },
  'minskoff': {
    canonical: 'Minskoff Theatre',
    address: '200 W 45th St',
    seats: 1710,
    aliases: []
  },
  'nederlander': {
    canonical: 'Nederlander Theatre',
    address: '208 W 41st St',
    seats: 1232,
    aliases: ['National Theatre', 'Billy Rose Theatre']
  },
  'neil-simon': {
    canonical: 'Neil Simon Theatre',
    address: '250 W 52nd St',
    seats: 1362,
    aliases: ['Simon Theatre', 'Alvin Theatre']
  },
  'richard-rodgers': {
    canonical: 'Richard Rodgers Theatre',
    address: '226 W 46th St',
    seats: 1319,
    aliases: ['Rodgers Theatre', '46th Street Theatre']
  },
  'palace': {
    canonical: 'Palace Theatre',
    address: '1564 Broadway',
    seats: 1743,
    aliases: []
  },

  // === JUJAMCYN THEATERS (5 theaters) ===
  'august-wilson': {
    canonical: 'August Wilson Theatre',
    address: '245 W 52nd St',
    seats: 1222,
    aliases: ['Virginia Theatre'],
    renamed: '2005-10-16'
  },
  'al-hirschfeld': {
    canonical: 'Al Hirschfeld Theatre',
    address: '302 W 45th St',
    seats: 1437,
    aliases: ['Hirschfeld Theatre', 'Martin Beck Theatre'],
    renamed: '2003-06-21'
  },
  'eugene-oneill': {
    canonical: "Eugene O'Neill Theatre",
    address: '230 W 49th St',
    seats: 1108,
    aliases: ["O'Neill Theatre", 'Forrest Theatre']
  },
  'walter-kerr': {
    canonical: 'Walter Kerr Theatre',
    address: '219 W 48th St',
    seats: 947,
    aliases: ['Kerr Theatre', 'Ritz Theatre']
  },
  'st-james': {
    canonical: 'St. James Theatre',
    address: '246 W 44th St',
    seats: 1709,
    aliases: ['Saint James Theatre']
  },

  // === DISNEY THEATRICAL ===
  'new-amsterdam': {
    canonical: 'New Amsterdam Theatre',
    address: '214 W 42nd St',
    seats: 1747,
    aliases: []
  },

  // === ROUNDABOUT THEATRE COMPANY ===
  'stephen-sondheim': {
    canonical: 'Stephen Sondheim Theatre',
    address: '124 W 43rd St',
    seats: 1055,
    aliases: ['Sondheim Theatre', 'Henry Miller Theatre'],
    renamed: '2010-09-15'
  },
  'todd-haimes': {
    canonical: 'Todd Haimes Theatre',
    address: '227 W 42nd St',
    seats: 1024,
    aliases: ['American Airlines Theatre'],
    renamed: '2023-09-12'
  },
  'harold-and-miriam-steinberg': {
    canonical: 'Harold and Miriam Steinberg Center for Theatre',
    address: '111 W 46th St',
    seats: 499,
    aliases: ['Studio 54'],
    note: 'Often listed as Studio 54'
  },

  // === LINCOLN CENTER THEATER ===
  'vivian-beaumont': {
    canonical: 'Vivian Beaumont Theater',
    address: '150 W 65th St',
    seats: 1080,
    aliases: ['Beaumont Theatre', 'Beaumont Theater']
  },

  // === SECOND STAGE ===
  'hayes': {
    canonical: 'Helen Hayes Theater',
    address: '240 W 44th St',
    seats: 597,
    aliases: ['Helen Hayes Theatre', 'Hayes Theater', 'Little Theatre'],
    note: 'Smallest Broadway house'
  },

  // === MANHATTAN THEATRE CLUB ===
  'friedman': {
    canonical: 'Samuel J. Friedman Theatre',
    address: '261 W 47th St',
    seats: 650,
    aliases: ['Friedman Theatre', 'Biltmore Theatre'],
    renamed: '2008-06-19'
  },

  // === CIRCLE IN THE SQUARE ===
  'circle-in-the-square': {
    canonical: 'Circle in the Square Theatre',
    address: '235 W 50th St',
    seats: 776,
    aliases: [],
    note: 'Only arena-style Broadway theater'
  },

  // === HUDSON THEATRES ===
  'hudson': {
    canonical: 'Hudson Theatre',
    address: '145 W 44th St',
    seats: 970,
    aliases: []
  },

  // === AMBASSADOR THEATRE GROUP ===
  'lyric': {
    canonical: 'Lyric Theatre',
    address: '214 W 43rd St',
    seats: 1896,
    aliases: ['Ford Center', 'Hilton Theatre'],
    renamed: '2014-08-01'
  },

  // === OTHER ===
  'belasco': {
    canonical: 'Belasco Theatre',
    address: '111 W 44th St',
    seats: 1016,
    aliases: []
  },
  'studio-54': {
    canonical: 'Studio 54',
    address: '254 W 54th St',
    seats: 1006,
    aliases: [],
    note: 'Roundabout Theatre Company home'
  },
};

/**
 * Normalize a venue name for lookup
 */
function normalizeVenueName(name) {
  if (!name) return '';

  return name
    .toLowerCase()
    // Normalize Theatre/Theater
    .replace(/theatre/g, 'theater')
    // Remove "The" prefix
    .replace(/^the\s+/, '')
    // Remove possessive apostrophes
    .replace(/['']s?\s*/g, ' ')
    // Remove punctuation
    .replace(/[.,'"]/g, '')
    // Normalize spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find theater by name (handles aliases and variations)
 */
function findTheater(venueName) {
  const normalized = normalizeVenueName(venueName);

  for (const [key, theater] of Object.entries(BROADWAY_THEATERS)) {
    // Check canonical name
    if (normalizeVenueName(theater.canonical) === normalized) {
      return { key, ...theater };
    }

    // Check aliases
    for (const alias of theater.aliases || []) {
      if (normalizeVenueName(alias) === normalized) {
        return { key, ...theater };
      }
    }

    // Check partial match (e.g., "Booth" matches "Booth Theatre")
    const canonicalNorm = normalizeVenueName(theater.canonical);
    if (canonicalNorm.includes(normalized) || normalized.includes(canonicalNorm.replace(' theater', ''))) {
      return { key, ...theater };
    }
  }

  return null;
}

/**
 * Check if a venue is an official Broadway theater
 */
function isOfficialBroadwayTheater(venueName) {
  return findTheater(venueName) !== null;
}

/**
 * Get the canonical name for a venue
 */
function getCanonicalVenueName(venueName) {
  const theater = findTheater(venueName);
  return theater ? theater.canonical : venueName;
}

/**
 * Validate a venue and return details
 */
function validateVenue(venueName) {
  const theater = findTheater(venueName);

  if (!theater) {
    return {
      isValid: false,
      canonical: venueName,
      reason: `"${venueName}" is not a recognized Broadway theater`
    };
  }

  return {
    isValid: true,
    canonical: theater.canonical,
    seats: theater.seats,
    address: theater.address,
    wasRenamed: theater.renamed ? true : false
  };
}

module.exports = {
  BROADWAY_THEATERS,
  normalizeVenueName,
  findTheater,
  isOfficialBroadwayTheater,
  getCanonicalVenueName,
  validateVenue,
};
