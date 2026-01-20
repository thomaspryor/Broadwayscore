// Scoring Configuration - Version controlled methodology
// Change this file to update scoring rules site-wide

export const METHODOLOGY_VERSION = "1.0.0";
export const METHODOLOGY_DATE = "2026-01-20";

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
export const OUTLET_TIERS: Record<string, { tier: 1 | 2 | 3; weight: number }> = {
  // Tier 1: Major national publications (1.5x weight)
  'The New York Times': { tier: 1, weight: 1.5 },
  'Vulture': { tier: 1, weight: 1.5 },
  'Variety': { tier: 1, weight: 1.5 },
  'The Hollywood Reporter': { tier: 1, weight: 1.5 },
  'Time Out New York': { tier: 1, weight: 1.5 },
  'The Washington Post': { tier: 1, weight: 1.5 },

  // Tier 2: Major theatre-focused outlets (1.0x weight)
  'TheaterMania': { tier: 2, weight: 1.0 },
  'Broadway News': { tier: 2, weight: 1.0 },
  'BroadwayWorld': { tier: 2, weight: 1.0 },
  'New York Magazine': { tier: 2, weight: 1.0 },
  'Entertainment Weekly': { tier: 2, weight: 1.0 },
  'The Guardian': { tier: 2, weight: 1.0 },
  'Associated Press': { tier: 2, weight: 1.0 },
  'New York Post': { tier: 2, weight: 1.0 },
  'amNewYork': { tier: 2, weight: 1.0 },

  // Tier 3: Smaller outlets (0.5x weight)
  // Any unlisted outlet defaults to tier 3
};

export const DEFAULT_TIER_WEIGHT = 0.5;

// ===========================================
// RATING NORMALIZATION MAPPINGS
// ===========================================

// Letter grades → 0-100
export const LETTER_GRADE_MAP: Record<string, number> = {
  'A+': 98, 'A': 95, 'A-': 92,
  'B+': 88, 'B': 85, 'B-': 82,
  'C+': 78, 'C': 75, 'C-': 72,
  'D+': 68, 'D': 65, 'D-': 62,
  'F': 50,
};

// Sentiment keywords → 0-100 (used when no explicit rating)
export const SENTIMENT_MAP: Record<string, number> = {
  'rave': 95,
  'positive': 80,
  'mixed-positive': 65,
  'mixed': 55,
  'mixed-negative': 45,
  'negative': 30,
  'pan': 15,
};

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
  baselineThreads: 10,       // Expected threads for "average" buzz
  volumeMaxScore: 50,        // Max points from volume

  // Sentiment scoring
  sentimentMaxScore: 50,     // Max points from sentiment
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
// CONFIDENCE RULES
// ===========================================
export const CONFIDENCE_RULES = {
  high: {
    minCriticReviews: 10,
    minTier1Reviews: 3,
    minAudiencePlatforms: 2,
  },
  medium: {
    minCriticReviews: 5,
    minTier1Reviews: 1,
    minAudiencePlatforms: 1,
  },
  // Below medium thresholds = low
};

// ===========================================
// INFERRED SCORE PENALTIES
// ===========================================
export const INFERRED_PENALTY = 0.5; // 50% weight for inferred scores

// ===========================================
// DIVERGENCE THRESHOLDS
// ===========================================
export const AUDIENCE_DIVERGENCE_THRESHOLD = 20; // Points difference to trigger warning
