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
  'newyorker': 'NEWYORKER',
  'telegraph': 'TELEGRAPH',
  'standard': 'STANDARD',
  'times-uk': 'TIMES-UK',

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
  'financialtimes': 'FT',
  'thestage': 'STAGE-UK',
  'whatsonstage': 'WHATSONSTAGE',
  'london-theatre': 'LONDONTHEATRE',
  'independent': 'INDEPENDENT',
  'i-paper': 'I-PAPER',

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
  'forward': 'FORWARD',
  'fort-worth-star-telegram': 'FORTWORTHST',
  'new-jersey-newsroom': 'NJNEWSROOM',
  'theater-news-online': 'THEATERNEWS',
};

// Auto-generated alias mappings from outlet-registry.json aliases field.
// Built lazily on first access. For each outlet in REGISTRY_TO_SCORING,
// all its registry aliases are normalized (lowercase, spaces→hyphens) and
// mapped to the same scoring ID. Eliminates manual maintenance.
//
// Manual overrides for aliases NOT in the registry (typos, critic-specific IDs):
const MANUAL_ALIAS_OVERRIDES: Record<string, string> = {
  '1-minute-critic-matthew-wexler': 'OMC',
  'london-theatre-direct': 'LONDONTHEATRE',
  'new-york': 'VULT',  // New York Magazine (nymag.com) — too generic for registry
  'shelby-star-patrick-ryan': 'USATODAY',  // critic-specific alias
  'nbc-news': 'NBC',
  'timeout-london': 'TIMEOUT-LONDON',  // separate from Time Out NY
  'time-out-london': 'TIMEOUT-LONDON',
};

let _aliasCache: Record<string, string> | null = null;

function _buildAliasMap(): Record<string, string> {
  if (_aliasCache) return _aliasCache;
  _aliasCache = {};

  try {
    const fs = require('fs');
    const path = require('path');
    const registryPath = path.join(process.cwd(), 'data', 'outlet-registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const outlets = registry.outlets || registry;

      // Build reverse map: for each registry ID in REGISTRY_TO_SCORING,
      // map all its aliases to the scoring ID
      for (const [registryId, scoringId] of Object.entries(REGISTRY_TO_SCORING)) {
        const outletData = outlets[registryId];
        if (!outletData?.aliases) continue;

        for (const alias of outletData.aliases as string[]) {
          const normalized = alias.toLowerCase().trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
          if (!normalized || normalized === registryId) continue;
          // Skip if it's already a primary mapping
          if (REGISTRY_TO_SCORING[normalized]) continue;
          // First match wins — don't overwrite existing aliases
          if (!_aliasCache[normalized]) {
            _aliasCache[normalized] = scoringId;
          }
        }
      }
    }
  } catch {
    // Registry not available — return empty (manual overrides still work)
  }

  // Apply manual overrides (these always win)
  Object.assign(_aliasCache, MANUAL_ALIAS_OVERRIDES);
  return _aliasCache;
}

// Lazy-loaded alias map — auto-generated from registry + manual overrides
export const REGISTRY_ALIASES_TO_SCORING: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop: string) {
      return _buildAliasMap()[prop];
    },
    has(_target, prop: string) {
      return prop in _buildAliasMap();
    },
    ownKeys() {
      return Object.keys(_buildAliasMap());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const map = _buildAliasMap();
      if (prop in map) {
        return { value: map[prop], writable: false, enumerable: true, configurable: true };
      }
      return undefined;
    },
  }
);

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
