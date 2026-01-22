// Scoring Configuration - Version controlled methodology
// Based on user's Google Sheet methodology
// Change this file to update scoring rules site-wide

export const METHODOLOGY_VERSION = "2.0.0";
export const METHODOLOGY_DATE = "2026-01-21";

// ===========================================
// COMPONENT WEIGHTS (must sum to 1.0)
// ===========================================
export const COMPONENT_WEIGHTS = {
  critic: 0.50,
  audience: 0.35,
  buzz: 0.15,
};

// ===========================================
// OUTLET TIER DEFINITIONS & WEIGHTS
// ===========================================
export const TIER_WEIGHTS = {
  1: 1.0,
  2: 0.70,
  3: 0.40,
} as const;

export const DEFAULT_TIER = 3 as const;

// Outlet ID → Tier mapping
export const OUTLET_TIERS: Record<string, { tier: 1 | 2 | 3; name: string; scoreFormat: string; maxScale?: number }> = {
  // Tier 1: Major national publications & top culture sites
  'NYT': { tier: 1, name: 'The New York Times', scoreFormat: 'text_bucket' },
  'WASHPOST': { tier: 1, name: 'The Washington Post', scoreFormat: 'text_bucket' },
  'LATIMES': { tier: 1, name: 'Los Angeles Times', scoreFormat: 'text_bucket' },
  'WSJ': { tier: 1, name: 'The Wall Street Journal', scoreFormat: 'text_bucket' },
  'AP': { tier: 1, name: 'Associated Press', scoreFormat: 'text_bucket' },
  'VARIETY': { tier: 1, name: 'Variety', scoreFormat: 'text_bucket' },
  'THR': { tier: 1, name: 'The Hollywood Reporter', scoreFormat: 'text_bucket' },
  'VULT': { tier: 1, name: 'Vulture', scoreFormat: 'text_bucket' },
  'GUARDIAN': { tier: 1, name: 'The Guardian', scoreFormat: 'stars', maxScale: 5 },
  'TIMEOUTNY': { tier: 1, name: 'Time Out New York', scoreFormat: 'stars', maxScale: 5 },
  'BWAYNEWS': { tier: 1, name: 'Broadway News', scoreFormat: 'text_bucket' },

  // Tier 2: Regional papers, trades, theatre-specific outlets
  'CHTRIB': { tier: 2, name: 'Chicago Tribune', scoreFormat: 'text_bucket' },
  'USATODAY': { tier: 2, name: 'USA Today', scoreFormat: 'text_bucket' },
  'NYDN': { tier: 2, name: 'New York Daily News', scoreFormat: 'text_bucket' },
  'NYP': { tier: 2, name: 'New York Post', scoreFormat: 'text_bucket' },
  'WRAP': { tier: 2, name: 'The Wrap', scoreFormat: 'text_bucket' },
  'EW': { tier: 2, name: 'Entertainment Weekly', scoreFormat: 'letter' },
  'INDIEWIRE': { tier: 2, name: 'IndieWire', scoreFormat: 'text_bucket' },
  'DEADLINE': { tier: 2, name: 'Deadline', scoreFormat: 'text_bucket' },
  'SLANT': { tier: 2, name: 'Slant Magazine', scoreFormat: 'stars', maxScale: 4 },
  'TDB': { tier: 2, name: 'The Daily Beast', scoreFormat: 'text_bucket' },
  'OBSERVER': { tier: 2, name: 'Observer', scoreFormat: 'text_bucket' },
  'NYTHTR': { tier: 2, name: 'New York Theater', scoreFormat: 'text_bucket' },
  'NYTG': { tier: 2, name: 'New York Theatre Guide', scoreFormat: 'text_bucket' },
  'NYSR': { tier: 2, name: 'New York Stage Review', scoreFormat: 'text_bucket' },
  'TMAN': { tier: 2, name: 'TheaterMania', scoreFormat: 'text_bucket' },
  'THLY': { tier: 2, name: 'Theatrely', scoreFormat: 'text_bucket' },

  // Tier 3: Smaller outlets, blogs, niche sites
  'AMNY': { tier: 3, name: 'amNewYork', scoreFormat: 'text_bucket' },
  'CITI': { tier: 3, name: 'Cititour', scoreFormat: 'text_bucket' },
  'CSCE': { tier: 3, name: 'Culture Sauce', scoreFormat: 'stars', maxScale: 5 },
  'FRONTMEZZ': { tier: 3, name: 'Front Mezz Junkies', scoreFormat: 'text_bucket' },
  'THERECS': { tier: 3, name: 'The Recs', scoreFormat: 'text_bucket' },
  'OMC': { tier: 3, name: 'One Minute Critic', scoreFormat: 'stars', maxScale: 5 },
  'BWW': { tier: 3, name: 'BroadwayWorld', scoreFormat: 'text_bucket' },
};

// ===========================================
// DESIGNATION BUMPS (added to base score)
// ===========================================
export const DESIGNATION_BUMPS: Record<string, number> = {
  'Critics_Pick': 3,      // NYT Critics' Pick
  'Critics_Choice': 2,    // Time Out Critic's Choice
  'Recommended': 2,       // Guardian Pick of the Week
};

// ===========================================
// RATING NORMALIZATION MAPPINGS
// ===========================================

// Letter grades → 0-100
export const LETTER_GRADE_MAP: Record<string, number> = {
  'A+': 100,
  'A': 95,
  'A-': 90,
  'B+': 85,
  'B': 80,
  'B-': 75,
  'C+': 70,
  'C': 65,
  'C-': 60,
  'D+': 55,
  'D': 50,
  'D-': 45,
  'F': 30,
};

// Sentiment bucket → 0-100
export const BUCKET_SCORE_MAP: Record<string, number> = {
  'Rave': 90,
  'Positive': 82,
  'mixed-positive': 72,
  'mixed-neutral': 65,
  'Mixed': 65,  // Alias
  'mixed-negative': 58,
  'Negative': 48,
  'Pan': 30,
};

// Thumb value → 0-100
export const THUMB_SCORE_MAP: Record<string, number> = {
  'Up': 80,
  'Flat': 60,
  'Down': 35,
};

// ===========================================
// STAR RATING CONVERSION
// ===========================================
// Convert star ratings to 0-100 scale
export function convertStarRating(stars: number, maxStars: number): number {
  return Math.round((stars / maxStars) * 100);
}

// ===========================================
// AUDIENCE PLATFORM WEIGHTS
// ===========================================
export const AUDIENCE_PLATFORM_WEIGHTS: Record<string, number> = {
  'showscore': 0.50,
  'google': 0.30,
  'mezzanine': 0.20,
  'other': 0.10,
};

// Minimum reviews required for full weight
export const AUDIENCE_MIN_REVIEWS = 50;

// ===========================================
// BUZZ SCORING PARAMETERS
// ===========================================
export const BUZZ_CONFIG = {
  // Volume scoring
  baselineThreads: 10,
  volumeMaxScore: 50,

  // Sentiment scoring
  sentimentMaxScore: 50,
  sentimentValues: {
    positive: 50,
    mixed: 25,
    negative: 0,
  },

  // Staleness
  stalenessThresholdDays: 30,
  stalenessPenalty: 10,

  // Recency window
  recencyWindowDays: 14,
};

// ===========================================
// CONFIDENCE RULES (based on review count)
// ===========================================
export const CONFIDENCE_THRESHOLDS = {
  high: 15,   // 15+ reviews
  medium: 6,  // 6+ reviews
  // Below 6 = low
};

export const CONFIDENCE_RULES = {
  high: {
    minCriticReviews: 15,
    minTier1Reviews: 3,
    minAudiencePlatforms: 2,
  },
  medium: {
    minCriticReviews: 6,
    minTier1Reviews: 1,
    minAudiencePlatforms: 1,
  },
};

// ===========================================
// CRITIC SCORE LABEL THRESHOLDS
// ===========================================
export const CRITIC_LABEL_THRESHOLDS = {
  'Rave': 85,
  'Positive': 70,
  'Mixed': 50,
  'Negative': 0,
};

export function getCriticLabel(score: number): string {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 50) return 'Mixed';
  return 'Negative';
}

// ===========================================
// DIVERGENCE THRESHOLDS
// ===========================================
export const AUDIENCE_DIVERGENCE_THRESHOLD = 20;
