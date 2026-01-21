/**
 * Configuration for the Critic Reviews Agent
 *
 * This file defines all outlets, their scoring formats, and normalization rules.
 * Keeping this centralized ensures consistency across all runs.
 */

import { OutletConfig } from './types';

// ===========================================
// OUTLET CONFIGURATIONS
// ===========================================
// Each outlet has a unique ID, tier, and scoring format
// Aliases help match outlet names from different sources

export const OUTLETS: OutletConfig[] = [
  // ===== TIER 1: Major national publications =====
  {
    id: 'NYT',
    name: 'The New York Times',
    tier: 1,
    aliases: ['New York Times', 'NYTimes', 'NY Times', 'nytimes.com'],
    domain: 'nytimes.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.nytimes.com/search?query=${encodeURIComponent(title + ' theater review')}&sort=newest`,
  },
  {
    id: 'WASHPOST',
    name: 'The Washington Post',
    tier: 1,
    aliases: ['Washington Post', 'WashPost', 'washingtonpost.com'],
    domain: 'washingtonpost.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.washingtonpost.com/search/?query=${encodeURIComponent(title + ' broadway review')}`,
  },
  {
    id: 'LATIMES',
    name: 'Los Angeles Times',
    tier: 1,
    aliases: ['LA Times', 'L.A. Times', 'latimes.com'],
    domain: 'latimes.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.latimes.com/search?q=${encodeURIComponent(title + ' broadway review')}`,
  },
  {
    id: 'WSJ',
    name: 'The Wall Street Journal',
    tier: 1,
    aliases: ['Wall Street Journal', 'WSJ', 'wsj.com'],
    domain: 'wsj.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.wsj.com/search?query=${encodeURIComponent(title + ' theater review')}`,
  },
  {
    id: 'AP',
    name: 'Associated Press',
    tier: 1,
    aliases: ['AP', 'AP News', 'apnews.com'],
    domain: 'apnews.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://apnews.com/search?q=${encodeURIComponent(title + ' broadway review')}`,
  },
  {
    id: 'VARIETY',
    name: 'Variety',
    tier: 1,
    aliases: ['variety.com'],
    domain: 'variety.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://variety.com/?s=${encodeURIComponent(title + ' review')}&post_type=review`,
  },
  {
    id: 'THR',
    name: 'The Hollywood Reporter',
    tier: 1,
    aliases: ['Hollywood Reporter', 'THR', 'hollywoodreporter.com'],
    domain: 'hollywoodreporter.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.hollywoodreporter.com/c/reviews/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'VULT',
    name: 'Vulture',
    tier: 1,
    aliases: ['vulture.com'],
    domain: 'vulture.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.vulture.com/search?q=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'GUARDIAN',
    name: 'The Guardian',
    tier: 1,
    aliases: ['Guardian', 'theguardian.com'],
    domain: 'theguardian.com',
    scoreFormat: 'stars',
    maxScale: 5,
    searchUrl: (title) => `https://www.theguardian.com/stage/search?q=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'TIMEOUTNY',
    name: 'Time Out New York',
    tier: 1,
    aliases: ['Time Out', 'TimeOut', 'timeout.com'],
    domain: 'timeout.com',
    scoreFormat: 'stars',
    maxScale: 5,
    searchUrl: (title) => `https://www.timeout.com/newyork/search?q=${encodeURIComponent(title)}&type=theater`,
  },
  {
    id: 'BWAYNEWS',
    name: 'Broadway News',
    tier: 1,
    aliases: ['broadwaynews.com'],
    domain: 'broadwaynews.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://broadwaynews.com/?s=${encodeURIComponent(title + ' review')}`,
  },

  // ===== TIER 2: Regional papers, trades, theatre outlets =====
  {
    id: 'CHTRIB',
    name: 'Chicago Tribune',
    tier: 2,
    aliases: ['chicagotribune.com'],
    domain: 'chicagotribune.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.chicagotribune.com/search/${encodeURIComponent(title + ' broadway review')}/`,
  },
  {
    id: 'USATODAY',
    name: 'USA Today',
    tier: 2,
    aliases: ['usatoday.com'],
    domain: 'usatoday.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.usatoday.com/search/?q=${encodeURIComponent(title + ' broadway review')}`,
  },
  {
    id: 'NYDN',
    name: 'New York Daily News',
    tier: 2,
    aliases: ['NY Daily News', 'Daily News', 'nydailynews.com'],
    domain: 'nydailynews.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.nydailynews.com/search/${encodeURIComponent(title + ' theater review')}/`,
  },
  {
    id: 'NYP',
    name: 'New York Post',
    tier: 2,
    aliases: ['NY Post', 'nypost.com'],
    domain: 'nypost.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://nypost.com/?s=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'WRAP',
    name: 'The Wrap',
    tier: 2,
    aliases: ['TheWrap', 'thewrap.com'],
    domain: 'thewrap.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.thewrap.com/?s=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'EW',
    name: 'Entertainment Weekly',
    tier: 2,
    aliases: ['EW', 'ew.com'],
    domain: 'ew.com',
    scoreFormat: 'letter',
    searchUrl: (title) => `https://ew.com/?s=${encodeURIComponent(title + ' broadway review')}`,
  },
  {
    id: 'INDIEWIRE',
    name: 'IndieWire',
    tier: 2,
    aliases: ['indiewire.com'],
    domain: 'indiewire.com',
    scoreFormat: 'letter',
    searchUrl: (title) => `https://www.indiewire.com/?s=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'DEADLINE',
    name: 'Deadline',
    tier: 2,
    aliases: ['deadline.com'],
    domain: 'deadline.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://deadline.com/?s=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'SLANT',
    name: 'Slant Magazine',
    tier: 2,
    aliases: ['Slant', 'slantmagazine.com'],
    domain: 'slantmagazine.com',
    scoreFormat: 'stars',
    maxScale: 4,
    searchUrl: (title) => `https://www.slantmagazine.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'TDB',
    name: 'The Daily Beast',
    tier: 2,
    aliases: ['Daily Beast', 'thedailybeast.com'],
    domain: 'thedailybeast.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.thedailybeast.com/search?q=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'OBSERVER',
    name: 'Observer',
    tier: 2,
    aliases: ['NY Observer', 'observer.com'],
    domain: 'observer.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://observer.com/?s=${encodeURIComponent(title + ' broadway')}`,
  },
  {
    id: 'NYTHTR',
    name: 'New York Theater',
    tier: 2,
    aliases: ['newyorktheater.me', 'NY Theater'],
    domain: 'newyorktheater.me',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://newyorktheater.me/?s=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'NYTG',
    name: 'New York Theatre Guide',
    tier: 2,
    aliases: ['NY Theatre Guide', 'newyorktheatreguide.com'],
    domain: 'newyorktheatreguide.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.newyorktheatreguide.com/search?q=${encodeURIComponent(title + ' review')}`,
  },
  {
    id: 'NYSR',
    name: 'New York Stage Review',
    tier: 2,
    aliases: ['NY Stage Review', 'nystagereview.com'],
    domain: 'nystagereview.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://nystagereview.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'TMAN',
    name: 'TheaterMania',
    tier: 2,
    aliases: ['Theater Mania', 'theatermania.com'],
    domain: 'theatermania.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.theatermania.com/search?q=${encodeURIComponent(title)}`,
  },
  {
    id: 'THLY',
    name: 'Theatrely',
    tier: 2,
    aliases: ['theatrely.com'],
    domain: 'theatrely.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.theatrely.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'BWAYJOURNAL',
    name: 'Broadway Journal',
    tier: 2,
    aliases: ['broadwayjournal.com'],
    domain: 'broadwayjournal.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://broadwayjournal.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'STAGEBUDDY',
    name: 'Stage Buddy',
    tier: 2,
    aliases: ['stagebuddy.com'],
    domain: 'stagebuddy.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://stagebuddy.com/?s=${encodeURIComponent(title)}`,
  },

  // ===== TIER 3: Smaller outlets, blogs =====
  {
    id: 'BWW',
    name: 'BroadwayWorld',
    tier: 3,
    aliases: ['Broadway World', 'broadwayworld.com'],
    domain: 'broadwayworld.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.broadwayworld.com/search/?q=${encodeURIComponent(title + ' review')}&searchtype=articles`,
  },
  {
    id: 'AMNY',
    name: 'amNewYork',
    tier: 3,
    aliases: ['amNY', 'amnewyork.com'],
    domain: 'amnewyork.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.amnewyork.com/?s=${encodeURIComponent(title + ' broadway')}`,
  },
  {
    id: 'CITI',
    name: 'Cititour',
    tier: 3,
    aliases: ['cititour.com'],
    domain: 'cititour.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://cititour.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'CSCE',
    name: 'Culture Sauce',
    tier: 3,
    aliases: ['CultureSauce', 'culturesauce.com'],
    domain: 'culturesauce.com',
    scoreFormat: 'stars',
    maxScale: 5,
    searchUrl: (title) => `https://culturesauce.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'FRONTMEZZ',
    name: 'Front Mezz Junkies',
    tier: 3,
    aliases: ['Front Mezzanine', 'frontmezzjunkies.com'],
    domain: 'frontmezzjunkies.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://frontmezzjunkies.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'THERECS',
    name: 'The Recs',
    tier: 3,
    aliases: ['therecs.com'],
    domain: 'therecs.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://therecs.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'OMC',
    name: 'One Minute Critic',
    tier: 3,
    aliases: ['1 Minute Critic', '1minutecritic.com'],
    domain: '1minutecritic.com',
    scoreFormat: 'stars',
    maxScale: 5,
    searchUrl: (title) => `https://1minutecritic.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'TALKIN',
    name: 'Talkin\' Broadway',
    tier: 3,
    aliases: ['Talkin Broadway', 'talkinbroadway.com'],
    domain: 'talkinbroadway.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://www.talkinbroadway.com/search?q=${encodeURIComponent(title)}`,
  },
  {
    id: 'BWAYBOX',
    name: 'The Broadway Box',
    tier: 3,
    aliases: ['Broadway Box', 'thebroadwaybox.com'],
    domain: 'thebroadwaybox.com',
    scoreFormat: 'text_bucket',
    enabled: false, // Not a review site
  },
  {
    id: 'BWAYBLOG',
    name: 'The Broadway Blog',
    tier: 3,
    aliases: ['Broadway Blog', 'thebroadwayblog.com'],
    domain: 'thebroadwayblog.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://thebroadwayblog.com/?s=${encodeURIComponent(title)}`,
  },
  {
    id: 'PLAYBILL',
    name: 'Playbill',
    tier: 3,
    aliases: ['playbill.com'],
    domain: 'playbill.com',
    scoreFormat: 'text_bucket',
    searchUrl: (title) => `https://playbill.com/searchpage#checks_q=${encodeURIComponent(title)}`,
  },
];

// ===========================================
// OUTLET HELPER FUNCTIONS
// ===========================================

/**
 * Get all outlets that have search URLs configured
 */
export function getSearchableOutlets(): OutletConfig[] {
  return OUTLETS.filter(outlet => outlet.searchUrl && outlet.enabled !== false);
}

/**
 * Get outlets by tier
 */
export function getOutletsByTier(tier: 1 | 2 | 3): OutletConfig[] {
  return OUTLETS.filter(outlet => outlet.tier === tier);
}

// ===========================================
// RATING CONVERSION MAPS
// ===========================================

// Letter grades → 0-100
export const LETTER_GRADE_MAP: Record<string, number> = {
  'A+': 98,
  'A': 95,
  'A-': 91,
  'B+': 87,
  'B': 83,
  'B-': 79,
  'C+': 75,
  'C': 71,
  'C-': 67,
  'D+': 63,
  'D': 59,
  'D-': 55,
  'F': 40,
};

// Text bucket descriptions → 0-100 (used for text-based reviews)
// These are default midpoints; actual score may vary based on review tone
export const TEXT_BUCKET_MAP: Record<string, number> = {
  // Highly positive
  'rave': 92,
  'ecstatic': 95,
  'masterpiece': 97,
  'excellent': 90,
  'outstanding': 90,
  'brilliant': 92,

  // Positive
  'positive': 80,
  'favorable': 78,
  'good': 76,
  'enjoyable': 75,
  'recommended': 77,
  'solid': 74,

  // Mixed-positive
  'mixed-positive': 68,
  'mostly positive': 70,
  'generally favorable': 69,
  'mixed positive': 68,

  // Mixed
  'mixed': 60,
  'middling': 58,
  'uneven': 55,
  'so-so': 55,

  // Mixed-negative
  'mixed-negative': 48,
  'mostly negative': 45,
  'mixed negative': 48,
  'lukewarm': 52,

  // Negative
  'negative': 38,
  'unfavorable': 35,
  'disappointing': 40,
  'poor': 35,

  // Pan
  'pan': 25,
  'terrible': 20,
  'awful': 18,
  'disastrous': 15,
};

// Thumb rating → 0-100
export const THUMB_MAP: Record<string, number> = {
  'up': 78,
  'thumbs up': 78,
  'yes': 78,
  'recommend': 78,
  'flat': 58,
  'sideways': 58,
  'maybe': 58,
  'down': 35,
  'thumbs down': 35,
  'no': 35,
  'skip': 35,
};

// ===========================================
// SCORE → BUCKET/THUMB DERIVATION
// ===========================================

export function scoreToBucket(score: number): 'Rave' | 'Positive' | 'Mixed' | 'Pan' {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 50) return 'Mixed';
  return 'Pan';
}

export function scoreToThumb(score: number): 'Up' | 'Flat' | 'Down' {
  if (score >= 70) return 'Up';
  if (score >= 50) return 'Flat';
  return 'Down';
}

// ===========================================
// DESIGNATION MAPPINGS
// ===========================================

export const DESIGNATION_PATTERNS: Array<{
  pattern: RegExp;
  designation: string;
}> = [
  { pattern: /critic'?s?\s*pick/i, designation: 'Critics_Pick' },
  { pattern: /critic'?s?\s*choice/i, designation: 'Critics_Choice' },
  { pattern: /recommended/i, designation: 'Recommended' },
  { pattern: /editor'?s?\s*pick/i, designation: 'Recommended' },
  { pattern: /must\s*see/i, designation: 'Recommended' },
];

// ===========================================
// AGGREGATOR SOURCES
// ===========================================

export const AGGREGATOR_SOURCES = {
  BROADWAY_WORLD: {
    name: 'BroadwayWorld',
    baseUrl: 'https://www.broadwayworld.com',
  },
  DID_THEY_LIKE_IT: {
    name: 'DidTheyLikeIt',
    baseUrl: 'https://didtheylikeit.com',
  },
  SHOW_SCORE: {
    name: 'Show-Score',
    baseUrl: 'https://www.show-score.com',
  },
} as const;

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Find outlet config by name, alias, or domain
 */
export function findOutletConfig(identifier: string): OutletConfig | undefined {
  const normalized = identifier.toLowerCase().trim();

  return OUTLETS.find(outlet => {
    // Check exact ID match
    if (outlet.id.toLowerCase() === normalized) return true;

    // Check name match
    if (outlet.name.toLowerCase() === normalized) return true;

    // Check aliases
    if (outlet.aliases.some(alias => alias.toLowerCase() === normalized)) return true;

    // Check domain (partial match for URLs)
    if (outlet.domain && normalized.includes(outlet.domain)) return true;

    return false;
  });
}

/**
 * Extract outlet from URL
 */
export function findOutletFromUrl(url: string): OutletConfig | undefined {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, '');

    return OUTLETS.find(outlet => {
      if (outlet.domain && domain.includes(outlet.domain.replace(/^www\./, ''))) {
        return true;
      }
      return false;
    });
  } catch {
    return undefined;
  }
}
