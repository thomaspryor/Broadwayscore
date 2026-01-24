/**
 * Outlet Configuration
 *
 * Canonical list of all tracked outlets with tier assignments and metadata.
 * This is the source of truth for outlet information.
 *
 * Tier Weights:
 * - Tier 1 (1.00): Major national publications, top culture sites
 * - Tier 2 (0.85): Regional papers, trades, theatre-specific outlets
 * - Tier 3 (0.70): Smaller outlets, blogs, niche sites
 */

import type { Outlet, OutletTier, ScoreFormat } from '@/types/canonical';

// ===========================================
// TIER WEIGHT MAPPING
// ===========================================

export const TIER_WEIGHTS: Record<OutletTier, number> = {
  1: 1.00,
  2: 0.85,
  3: 0.70,
};

// ===========================================
// OUTLET DEFINITIONS
// ===========================================

export const OUTLETS: Outlet[] = [
  // =========================================
  // TIER 1: Major national publications
  // =========================================
  {
    id: 'NYT',
    name: 'The New York Times',
    tier: 1,
    weight: 1.00,
    url: 'https://www.nytimes.com/section/theater',
    aliases: ['New York Times', 'NY Times', 'NYTimes', 'nytimes'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'VULT',
    name: 'Vulture',
    tier: 1,
    weight: 1.00,
    url: 'https://www.vulture.com/theater/',
    aliases: ['New York Magazine', 'NY Mag', 'nymag'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'VARIETY',
    name: 'Variety',
    tier: 1,
    weight: 1.00,
    url: 'https://variety.com/c/legit/',
    aliases: [],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'THR',
    name: 'The Hollywood Reporter',
    tier: 1,
    weight: 1.00,
    url: 'https://www.hollywoodreporter.com/c/news/theater-news/',
    aliases: ['Hollywood Reporter'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'GUARDIAN',
    name: 'The Guardian',
    tier: 1,
    weight: 1.00,
    url: 'https://www.theguardian.com/stage',
    aliases: ['Guardian'],
    scoreFormat: 'stars',
    maxScale: 5,
    isActive: true,
  },
  {
    id: 'WASHPOST',
    name: 'The Washington Post',
    tier: 1,
    weight: 1.00,
    url: 'https://www.washingtonpost.com/entertainment/theater/',
    aliases: ['Washington Post', 'WaPo'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'AP',
    name: 'Associated Press',
    tier: 1,
    weight: 1.00,
    url: 'https://apnews.com/',
    aliases: ['AP News'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NEWYORKER',
    name: 'The New Yorker',
    tier: 1,
    weight: 1.00,
    url: 'https://www.newyorker.com/goings-on-about-town/theatre',
    aliases: ['New Yorker'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'TIMEOUTNY',
    name: 'Time Out New York',
    tier: 1,
    weight: 1.00,
    url: 'https://www.timeout.com/newyork/theater',
    aliases: ['Time Out', 'TimeOut', 'Timeout'],
    scoreFormat: 'stars',
    maxScale: 5,
    isActive: true,
  },

  // =========================================
  // TIER 2: Regional papers, trades, theatre outlets
  // =========================================
  {
    id: 'TMAN',
    name: 'TheaterMania',
    tier: 2,
    weight: 0.85,
    url: 'https://www.theatermania.com/',
    aliases: ['Theatermania', 'Theater Mania'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NYP',
    name: 'New York Post',
    tier: 2,
    weight: 0.85,
    url: 'https://nypost.com/tag/broadway/',
    aliases: ['NY Post', 'nypost'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'DEADLINE',
    name: 'Deadline',
    tier: 2,
    weight: 0.85,
    url: 'https://deadline.com/tag/broadway/',
    aliases: ['Deadline Hollywood'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'EW',
    name: 'Entertainment Weekly',
    tier: 2,
    weight: 0.85,
    url: 'https://ew.com/',
    aliases: [],
    scoreFormat: 'letter',
    isActive: true,
  },
  {
    id: 'CHTRIB',
    name: 'Chicago Tribune',
    tier: 2,
    weight: 0.85,
    url: 'https://www.chicagotribune.com/entertainment/theater/',
    aliases: ['Chi Tribune'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'USATODAY',
    name: 'USA Today',
    tier: 2,
    weight: 0.85,
    url: 'https://www.usatoday.com/',
    aliases: [],
    scoreFormat: 'stars',
    maxScale: 4,
    isActive: true,
  },
  {
    id: 'NYDN',
    name: 'New York Daily News',
    tier: 2,
    weight: 0.85,
    url: 'https://www.nydailynews.com/',
    aliases: ['NY Daily News', 'Daily News'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'WRAP',
    name: 'The Wrap',
    tier: 2,
    weight: 0.85,
    url: 'https://www.thewrap.com/',
    aliases: ['TheWrap'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'TDB',
    name: 'The Daily Beast',
    tier: 2,
    weight: 0.85,
    url: 'https://www.thedailybeast.com/',
    aliases: ['Daily Beast'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'OBSERVER',
    name: 'Observer',
    tier: 2,
    weight: 0.85,
    url: 'https://observer.com/',
    aliases: ['NY Observer', 'New York Observer'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'INDIEWIRE',
    name: 'IndieWire',
    tier: 2,
    weight: 0.85,
    url: 'https://www.indiewire.com/',
    aliases: [],
    scoreFormat: 'letter',
    isActive: true,
  },
  {
    id: 'SLANT',
    name: 'Slant Magazine',
    tier: 2,
    weight: 0.85,
    url: 'https://www.slantmagazine.com/',
    aliases: ['Slant'],
    scoreFormat: 'stars',
    maxScale: 4,
    isActive: true,
  },
  {
    id: 'NYTHTR',
    name: 'New York Theater',
    tier: 2,
    weight: 0.85,
    url: 'https://newyorktheater.me/',
    aliases: ['NY Theater', 'newyorktheater'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NYTG',
    name: 'New York Theatre Guide',
    tier: 2,
    weight: 0.85,
    url: 'https://www.newyorktheatreguide.com/',
    aliases: ['NY Theatre Guide', 'NYTG'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NYSR',
    name: 'New York Stage Review',
    tier: 2,
    weight: 0.85,
    url: 'https://nystagereview.com/',
    aliases: ['NY Stage Review', 'Stage Review'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'THLY',
    name: 'Theatrely',
    tier: 2,
    weight: 0.85,
    url: 'https://theatrely.com/',
    aliases: [],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'BWAYNEWS',
    name: 'Broadway News',
    tier: 2,
    weight: 0.85,
    url: 'https://broadwaynews.com/',
    aliases: ['Broadway News'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'LATIMES',
    name: 'Los Angeles Times',
    tier: 2,
    weight: 0.85,
    url: 'https://www.latimes.com/entertainment-arts/story/theater',
    aliases: ['LA Times'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'WSJ',
    name: 'The Wall Street Journal',
    tier: 2,
    weight: 0.85,
    url: 'https://www.wsj.com/',
    aliases: ['Wall Street Journal', 'WSJ'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },

  // =========================================
  // TIER 3: Smaller outlets, blogs, niche sites
  // =========================================
  {
    id: 'BWW',
    name: 'BroadwayWorld',
    tier: 3,
    weight: 0.70,
    url: 'https://www.broadwayworld.com/',
    aliases: ['Broadway World'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'AMNY',
    name: 'amNewYork',
    tier: 3,
    weight: 0.70,
    url: 'https://www.amny.com/',
    aliases: ['AM New York', 'amNY'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'CITI',
    name: 'Cititour',
    tier: 3,
    weight: 0.70,
    url: 'https://cititour.com/',
    aliases: ['City Tour'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'CSCE',
    name: 'Culture Sauce',
    tier: 3,
    weight: 0.70,
    url: 'https://culturesauce.com/',
    aliases: ['CultureSauce'],
    scoreFormat: 'stars',
    maxScale: 5,
    isActive: true,
  },
  {
    id: 'FRONTMEZZ',
    name: 'Front Mezz Junkies',
    tier: 3,
    weight: 0.70,
    url: 'https://frontmezzjunkies.com/',
    aliases: ['FMJ', 'Front Mezzanine Junkies'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'THERECS',
    name: 'The Recs',
    tier: 3,
    weight: 0.70,
    url: 'https://therecs.com/',
    aliases: [],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'OMC',
    name: 'One Minute Critic',
    tier: 3,
    weight: 0.70,
    url: 'https://oneminutecritic.com/',
    aliases: ['1 Minute Critic'],
    scoreFormat: 'stars',
    maxScale: 5,
    isActive: true,
  },
  {
    id: 'STGCIN',
    name: 'Stage and Cinema',
    tier: 3,
    weight: 0.70,
    url: 'https://stageandcinema.com/',
    aliases: ['Stage & Cinema'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'BACKSTAGE',
    name: 'Backstage',
    tier: 3,
    weight: 0.70,
    url: 'https://www.backstage.com/',
    aliases: [],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NEWSDAY',
    name: 'Newsday',
    tier: 3,
    weight: 0.70,
    url: 'https://www.newsday.com/',
    aliases: [],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'NY1',
    name: 'NY1',
    tier: 3,
    weight: 0.70,
    url: 'https://www.ny1.com/',
    aliases: ['New York 1'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
  {
    id: 'HUFFPOST',
    name: 'HuffPost',
    tier: 3,
    weight: 0.70,
    url: 'https://www.huffpost.com/',
    aliases: ['Huffington Post'],
    scoreFormat: 'text_bucket',
    isActive: true,
  },
];

// ===========================================
// OUTLET LOOKUP FUNCTIONS
// ===========================================

/**
 * Find an outlet by its canonical ID
 */
export function getOutletById(id: string): Outlet | undefined {
  return OUTLETS.find(o => o.id === id);
}

/**
 * Find an outlet by name (checks name and aliases, case-insensitive)
 */
export function findOutletByName(name: string): Outlet | undefined {
  const normalized = name.toLowerCase().trim();

  return OUTLETS.find(outlet => {
    // Check main name
    if (outlet.name.toLowerCase() === normalized) return true;

    // Check aliases
    if (outlet.aliases?.some(alias => alias.toLowerCase() === normalized)) return true;

    // Partial match on name
    if (outlet.name.toLowerCase().includes(normalized) || normalized.includes(outlet.name.toLowerCase())) return true;

    return false;
  });
}

/**
 * Get all active outlets
 */
export function getActiveOutlets(): Outlet[] {
  return OUTLETS.filter(o => o.isActive);
}

/**
 * Get outlets by tier
 */
export function getOutletsByTier(tier: OutletTier): Outlet[] {
  return OUTLETS.filter(o => o.tier === tier && o.isActive);
}

/**
 * Get the tier weight for a tier number
 */
export function getTierWeight(tier: OutletTier): number {
  return TIER_WEIGHTS[tier];
}

/**
 * Get outlet config with fallback for unknown outlets
 */
export function getOutletConfig(outletId?: string, outletName?: string): Outlet {
  // Try by ID first
  if (outletId) {
    const outlet = getOutletById(outletId);
    if (outlet) return outlet;
  }

  // Try by name
  if (outletName) {
    const outlet = findOutletByName(outletName);
    if (outlet) return outlet;
  }

  // Return default tier 3 outlet
  return {
    id: outletId || 'UNKNOWN',
    name: outletName || 'Unknown Outlet',
    tier: 3,
    weight: TIER_WEIGHTS[3],
    scoreFormat: 'text_bucket',
    isActive: false,
  };
}

// ===========================================
// OUTLET ID MAPPING (for common variations)
// ===========================================

/**
 * Map common outlet name variations to canonical IDs
 */
export const OUTLET_NAME_TO_ID: Record<string, string> = {
  // NYT variations
  'the new york times': 'NYT',
  'new york times': 'NYT',
  'nytimes': 'NYT',
  'ny times': 'NYT',

  // Vulture/NY Mag
  'vulture': 'VULT',
  'new york magazine': 'VULT',
  'ny mag': 'VULT',

  // Hollywood Reporter
  'the hollywood reporter': 'THR',
  'hollywood reporter': 'THR',

  // Guardian
  'the guardian': 'GUARDIAN',
  'guardian': 'GUARDIAN',

  // Washington Post
  'the washington post': 'WASHPOST',
  'washington post': 'WASHPOST',
  'wapo': 'WASHPOST',

  // NY Post
  'new york post': 'NYP',
  'ny post': 'NYP',
  'nypost': 'NYP',

  // Time Out
  'time out new york': 'TIMEOUTNY',
  'time out': 'TIMEOUTNY',
  'timeout': 'TIMEOUTNY',

  // TheaterMania
  'theatermania': 'TMAN',
  'theater mania': 'TMAN',

  // BroadwayWorld
  'broadwayworld': 'BWW',
  'broadway world': 'BWW',

  // NY Stage Review
  'new york stage review': 'NYSR',
  'ny stage review': 'NYSR',

  // New Yorker
  'the new yorker': 'NEWYORKER',
  'new yorker': 'NEWYORKER',
};

/**
 * Normalize outlet name to canonical ID
 */
export function normalizeOutletId(name: string): string {
  const normalized = name.toLowerCase().trim();
  return OUTLET_NAME_TO_ID[normalized] || findOutletByName(name)?.id || 'UNKNOWN';
}
