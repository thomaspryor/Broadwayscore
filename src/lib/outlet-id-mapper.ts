// Outlet ID Mapper - Maps between scoring.ts uppercase IDs and outlet-registry.json lowercase IDs
//
// Problem: scoring.ts uses uppercase IDs (NYT, VULT, VARIETY)
//          outlet-registry.json uses lowercase IDs (nytimes, vulture, variety)
//          This mismatch causes getOutletConfig() to fail and default Tier 1 outlets to Tier 3
//
// Solution: Bidirectional mapping between the two ID formats

// Map from registry format (lowercase) to scoring format (uppercase)
// This covers ALL outlets defined in OUTLET_TIERS in src/config/scoring.ts
export const REGISTRY_TO_SCORING: Record<string, string> = {
  // Tier 1 outlets
  'nytimes': 'NYT',
  'washpost': 'WASHPOST',
  'latimes': 'LATIMES',
  'wsj': 'WSJ',
  'ap': 'AP',
  'variety': 'VARIETY',
  'hollywood-reporter': 'THR',
  'vulture': 'VULT',
  'guardian': 'GUARDIAN',
  'timeout': 'TIMEOUTNY',
  'broadwaynews': 'BWAYNEWS',

  // Tier 2 outlets
  'chicagotribune': 'CHTRIB',
  'usatoday': 'USATODAY',
  'nydailynews': 'NYDN',
  'nypost': 'NYP',
  'thewrap': 'WRAP',
  'ew': 'EW',
  'indiewire': 'INDIEWIRE',
  'deadline': 'DEADLINE',
  'slantmagazine': 'SLANT',
  'dailybeast': 'TDB',
  'observer': 'OBSERVER',
  'nyt-theater': 'NYTHTR',  // New York Theater (newyorktheater.me)
  'nytg': 'NYTG',           // New York Theatre Guide
  'nysr': 'NYSR',           // New York Stage Review
  'theatermania': 'TMAN',
  'theatrely': 'THLY',
  'newsday': 'NEWSDAY',
  'time': 'TIME',
  'rollingstone': 'ROLLSTONE',
  'bloomberg': 'BLOOMBERG',
  'vox': 'VOX',
  'slate': 'SLATE',
  'people': 'PEOPLE',
  'parade': 'PARADE',
  'billboard': 'BILLBOARD',
  'huffpost': 'HUFFPOST',
  'backstage': 'BACKSTAGE',
  'village-voice': 'VILLAGEVOICE',

  // Tier 3 outlets
  'amny': 'AMNY',
  'cititour': 'CITI',
  'culturesauce': 'CSCE',
  'frontmezzjunkies': 'FRONTMEZZ',
  'the-recs': 'THERECS',
  'one-minute-critic': 'OMC',
  'broadwayworld': 'BWW',
  'stageandcinema': 'STGCNMA',
  'talkinbroadway': 'TALKINBWAY',
  'ny1': 'NY1',
  'curtainup': 'CURTAINUP',
  'theater-scene': 'THEATERSCENE',
  'njcom': 'NJCOM',
  'stagezine': 'STAGEZINE',
  'mashable': 'MASHABLE',
  'wnyc': 'WNYC',
  'queerty': 'QUEERTY',
  'medium': 'MEDIUM',
  'exeunt-magazine': 'EXEUNT',
  'towleroad': 'TOWLEROAD',
  'northjerseycom': 'NORTHJERSEY',
  'nbcny': 'NBC',
};

// Additional alias mappings for common variations found in review data
// These map alternative registry IDs to their scoring equivalents
export const REGISTRY_ALIASES_TO_SCORING: Record<string, string> = {
  // Common variations
  'new-york-times': 'NYT',
  'washington-post': 'WASHPOST',
  'los-angeles-times': 'LATIMES',
  'wall-street-journal': 'WSJ',
  'associated-press': 'AP',
  'hollywood-reporter': 'THR',
  'time-out-new-york': 'TIMEOUTNY',
  'broadway-news': 'BWAYNEWS',
  'chicago-tribune': 'CHTRIB',
  'usa-today': 'USATODAY',
  'new-york-daily-news': 'NYDN',
  'ny-post': 'NYP',
  'the-wrap': 'WRAP',
  'entertainment-weekly': 'EW',
  'slant-magazine': 'SLANT',
  'the-daily-beast': 'TDB',
  'new-york-theater': 'NYTHTR',
  'new-york-theatre-guide': 'NYTG',
  'new-york-stage-review': 'NYSR',
  'theater-mania': 'TMAN',
  'rolling-stone': 'ROLLSTONE',
  'the-village-voice': 'VILLAGEVOICE',
  'am-new-york': 'AMNY',
  'culture-sauce': 'CSCE',
  'front-mezz-junkies': 'FRONTMEZZ',
  'broadway-world': 'BWW',
  'stage-and-cinema': 'STGCNMA',
  'talkin-broadway': 'TALKINBWAY',
  'curtain-up': 'CURTAINUP',
  'theater-scene': 'THEATERSCENE',
  'nj-com': 'NJCOM',
  'stage-zine': 'STAGEZINE',
  'exeunt': 'EXEUNT',
  'north-jersey': 'NORTHJERSEY',
  'nbc-new-york': 'NBC',
  'newyorker': 'NYT', // New Yorker maps to tier 1 (not in OUTLET_TIERS but should be tier 1)
};

// Reverse mapping: scoring format (uppercase) to registry format (lowercase)
export const SCORING_TO_REGISTRY: Record<string, string> =
  Object.fromEntries(
    Object.entries(REGISTRY_TO_SCORING).map(([registryId, scoringId]) => [scoringId, registryId])
  );

/**
 * Convert a registry-format ID (lowercase) to scoring-format ID (uppercase)
 * @param registryId - The lowercase ID from outlet-registry.json or review data
 * @returns The uppercase ID for OUTLET_TIERS lookup, or undefined if not found
 */
export function toScoringId(registryId: string): string | undefined {
  if (!registryId) return undefined;

  const normalized = registryId.toLowerCase().trim();

  // Try direct mapping first
  if (REGISTRY_TO_SCORING[normalized]) {
    return REGISTRY_TO_SCORING[normalized];
  }

  // Try alias mapping
  if (REGISTRY_ALIASES_TO_SCORING[normalized]) {
    return REGISTRY_ALIASES_TO_SCORING[normalized];
  }

  // If the ID is already uppercase and exists in scoring format, return as-is
  const upperCased = registryId.toUpperCase();
  if (SCORING_TO_REGISTRY[upperCased]) {
    return upperCased;
  }

  return undefined;
}

/**
 * Convert a scoring-format ID (uppercase) to registry-format ID (lowercase)
 * @param scoringId - The uppercase ID from OUTLET_TIERS
 * @returns The lowercase ID for outlet-registry.json lookup, or undefined if not found
 */
export function toRegistryId(scoringId: string): string | undefined {
  if (!scoringId) return undefined;

  const normalized = scoringId.toUpperCase().trim();
  return SCORING_TO_REGISTRY[normalized];
}

/**
 * Check if an outlet ID exists in either format
 * @param outletId - Any format of outlet ID
 * @returns true if the outlet is recognized
 */
export function isKnownOutlet(outletId: string): boolean {
  return toScoringId(outletId) !== undefined;
}
