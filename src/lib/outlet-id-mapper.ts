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

  // Tier 2 outlets — promoted from T3 (Feb 27 tier audit)
  'amny': 'AMNY',
  'talkinbroadway': 'TALKINBWAY',
  'ny1': 'NY1',
  'nbcny': 'NBC',
  'curtainup': 'CURTAINUP',
  'northjerseycom': 'NORTHJERSEY',
  'njcom': 'NJCOM',
  'bergen-record': 'BERGENRECORD',
  'wnyc': 'WNYC',

  // Tier 3 outlets
  'cititour': 'CITI',
  'culturesauce': 'CSCE',
  'frontmezzjunkies': 'FRONTMEZZ',
  'the-recs': 'THERECS',
  'one-minute-critic': 'OMC',
  'broadwayworld': 'BWW',
  'stageandcinema': 'STGCNMA',
  'theater-scene': 'THEATERSCENE',
  'stagezine': 'STAGEZINE',
  'mashable': 'MASHABLE',
  'queerty': 'QUEERTY',
  'medium': 'MEDIUM',
  'exeunt-magazine': 'EXEUNT',
  'towleroad': 'TOWLEROAD',
  'philadelphia-inquirer': 'PHILINQ',
  'chicago-sun-times': 'CHISUNTIMES',
  'new-york-sun': 'NYSUN',
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
  'newyorker': 'NEWYORKER',

  // Duplicate outlet ID aliases (found by tier audit)
  'bloomberg-news': 'BLOOMBERG',
  'newyorkmagazine': 'VULT',
  'vulturecom': 'VULT',
  'the-guardian-uk': 'GUARDIAN',
  'broadwayworldcom': 'BWW',
  'theaterscenecom': 'THEATERSCENE',
  'new-york-1': 'NY1',
  'observer-david-cote': 'OBSERVER',
  'chicago-tribute': 'CHTRIB',       // typo variant
  'ny-newsday': 'NEWSDAY',
  'associated-press-mark-kennedy': 'AP',
  'amny-matt-windman': 'AMNY',
  'amnycom': 'AMNY',
  'am-ny-matt-windman': 'AMNY',
  '1minutecritic': 'OMC',
  'oneminutecritic': 'OMC',
  '1-minute-critic-matthew-wexler': 'OMC',

  // Financial Times (new Tier 2 outlet)
  'financialtimes': 'FT',
  'financial-times-uk': 'FT',
  'financial-times': 'FT',

  // Additional aliases (Feb 2026 audit)
  'newyorktheater': 'NYTHTR',
  'new-york-theatre': 'NYTG',
  'new-york-theatre-guide-gillian-russo': 'NYTG',
  'the-star-ledger': 'NJCOM',
  'the-stage-uk': 'STAGE-UK',
  'the-telegraph-uk': 'TELEGRAPH',
  'northjereycom': 'NORTHJERSEY',
  'shelby-star-patrick-ryan': 'USATODAY',
  'forward-samuel-eli-shepherd': 'FORWARD',
  'the-record': 'BERGENRECORD',
  'the-record-bergen': 'BERGENRECORD',
  'fort-worth-star-telgram': 'FORTWORTHST',
  'new-york': 'VULT',                     // New York Magazine (nymag.com)

  // West End outlet aliases (Feb 2026 audit — these were all defaulting to Tier 3)
  // Tier 1 UK nationals
  'thestage': 'STAGE-UK',
  'evening-standard': 'STANDARD',
  'standard': 'STANDARD',
  'the-times-uk': 'TIMES-UK',
  'the-times': 'TIMES-UK',
  'times-uk': 'TIMES-UK',
  'telegraph': 'TELEGRAPH',
  // Tier 2 UK trade/specialist
  'whatsonstage': 'WHATSONSTAGE',
  'whats-on-stage': 'WHATSONSTAGE',
  'timeout-london': 'TIMEOUT-LONDON',
  'time-out-london': 'TIMEOUT-LONDON',
  'london-theatre': 'LONDONTHEATRE',
  'londontheatre': 'LONDONTHEATRE',
  'london-theatre-direct': 'LONDONTHEATRE',
  'the-independent-uk': 'INDEPENDENT',
  'independent': 'INDEPENDENT',
  'the-independent': 'INDEPENDENT',
  'the-stage': 'STAGE-UK',
  'stage-uk': 'STAGE-UK',
  'i-paper': 'I-PAPER',
  'the-i': 'I-PAPER',
  'i-newspaper': 'I-PAPER',

  // Duplicate outlet aliases (Feb 2026 normalization audit)
  'wnbc': 'NBC',
  'nbc-news': 'NBC',
  'citiour': 'CITI',
  'huffpo': 'HUFFPOST',
  'bloombergcom': 'BLOOMBERG',
  'northjersycom': 'NORTHJERSEY',
  'north-jerseycom': 'NORTHJERSEY',
  'exeunt-nyc': 'EXEUNT',
  'uk-daily-telegraph': 'TELEGRAPH',
  'jewish-daily-forward': 'FORWARD',
  'njnewsroom': 'NJNEWSROOM',
  'ny-1-time-out-magazine': 'NY1',
  'ny1-on-stage': 'NY1',
  'theater-new-online': 'THEATERNEWS',
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

// ===========================================
// REGISTRY-BASED TIER LOOKUP (fallback for unmapped outlets)
// ===========================================
// For the ~775 outlets not in REGISTRY_TO_SCORING, we can still resolve
// their tier directly from outlet-registry.json. This prevents them from
// silently defaulting to Tier 3 when their registry entry says otherwise.

let _registryTierCache: Record<string, number> | null = null;

function _loadRegistryTiers(): Record<string, number> {
  if (_registryTierCache) return _registryTierCache;
  _registryTierCache = {};
  try {
    const fs = require('fs');
    const path = require('path');
    const registryPath = path.join(process.cwd(), 'data', 'outlet-registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;
      for (const [id, entry] of Object.entries(outlets)) {
        const e = entry as { tier?: number };
        if (e.tier) _registryTierCache[id] = e.tier;
      }
    }
  } catch {
    // Registry not available (e.g., in browser context) — return empty
  }
  return _registryTierCache;
}

/**
 * Get the tier for an outlet directly from outlet-registry.json.
 * Use as a fallback when toScoringId() returns undefined (outlet not in mapper).
 * @param outletId - A canonical (lowercase) outlet ID
 * @returns The tier (1, 2, or 3), or undefined if not in registry
 */
export function getRegistryTier(outletId: string): number | undefined {
  if (!outletId) return undefined;
  const tiers = _loadRegistryTiers();
  return tiers[outletId.toLowerCase().trim()];
}
