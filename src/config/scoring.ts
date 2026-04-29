// Scoring Configuration - Version controlled methodology
// Based on user's Google Sheet methodology
// Change this file to update scoring rules site-wide

export const METHODOLOGY_VERSION = "2.2.0";
export const METHODOLOGY_DATE = "2026-02-22";

// ===========================================
// PRE-2005 REVIEW VISIBILITY
// ===========================================
// Pre-2005 closed shows have unreliable review data (wrong-production mixing,
// misattributed reviews from revivals). Hide reviews and scores entirely.
// Exception: shows still open (e.g., Wicked, Lion King, Chicago).
// Exception: shows manually curated with verified reviews (CURATED_HISTORICAL_SHOWS).
export const SCORE_DISPLAY_YEAR_CUTOFF = 2005;
export const MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF = 3;
export const LOW_CONF_SCORE_SOURCES = new Set([
  'llmScore-lowconf',
  'llmScore-thumb-boosted',
  'thumb',
  'bwwScore-fallback',
]);

// Shows pre-dating the 2005 cutoff that have been manually curated with
// verified opening-night reviews. Bypasses shouldHideReviews.
// To add a new historical show: edit data/curated-historical-shows.json (no code change needed).
import curatedHistoricalShowsData from '../../data/curated-historical-shows.json';
export const CURATED_HISTORICAL_SHOWS = new Set<string>(curatedHistoricalShowsData);

/** Returns true if a show's reviews should be completely hidden on the site. */
export function shouldHideReviews(show: { id?: string | null; openingDate?: string | null; status?: string; category?: string }): boolean {
  if (!show.openingDate) return false;
  const openingYear = new Date(show.openingDate).getFullYear();
  if (openingYear >= SCORE_DISPLAY_YEAR_CUTOFF) return false;
  // Still-open shows were explicitly collected — show their reviews
  if (show.status === 'open' || show.status === 'previews') return false;
  // Manually curated historical shows with verified reviews
  if (show.id && CURATED_HISTORICAL_SHOWS.has(show.id)) return false;
  return true;
}

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
// Note: These weights are distinct from other aggregators' methodologies
// to ensure our scoring approach is uniquely calibrated for Broadway.
// T4 added 2026-04-29 with v5 tier reassignment — single-author blog floor
// for outlets with neither aggregator pickup nor recognized-critic status.
// T3 raised from 0.35 to 0.40 to reflect that the noise floor now sits at T4.
export const TIER_WEIGHTS = {
  1: 1.0,
  2: 0.75,
  3: 0.40,
  4: 0.20,
} as const;

export const DEFAULT_TIER = 3 as const;

// Off-market multiplier applied to Off-Broadway / Off-West-End reviews.
// Acknowledges that off-market coverage is typically lighter / different
// critical engagement than the parent market. Set to 1.0 to disable.
export const OFF_MARKET_MULTIPLIER = 0.8 as const;

// Outlet ID → Tier mapping (keys are canonical lowercase registry IDs).
//
// SOURCE OF TRUTH: src/config/outlet-tiers.json
//
// Edit the JSON to add/change an outlet tier. Both TypeScript (this file,
// via import) and JavaScript (scripts/lib/compute-critic-score.js, via
// require) load from the same file, so drift between the two paths is
// impossible. Before April 2026, this data was duplicated in multiple
// files and drifted silently — causing homepage-vs-show-page score
// mismatches (Stereophonic incident, April 10, 2026).
import outletTiersJson from './outlet-tiers.json';

type OutletTierEntry = {
  tier: 1 | 2 | 3 | 4;
  // Per-region overrides — when present, overrides `tier` based on show region.
  // NYC = Broadway + Off-Broadway. London = West End + Off-West-End.
  tiers?: { nyc?: 1 | 2 | 3 | 4; london?: 1 | 2 | 3 | 4 };
  name: string;
  scoreFormat: string;
  maxScale?: number;
};
export const OUTLET_TIERS: Record<string, OutletTierEntry> = outletTiersJson as Record<string, OutletTierEntry>;

// ===========================================
// ===========================================
// DESIGNATION BUMPS (added to base score)
// ===========================================
export const DESIGNATION_BUMPS: Record<string, number> = {
  'Critics_Pick': 3,      // NYT Critics' Pick
  'Critics_Choice': 2,    // Time Out Critic's Choice
};

// Minimum score floors for designations (applied after bump)
export const DESIGNATION_FLOORS: Record<string, number> = {
  'Critics_Pick': 70,     // NYT Critics' Pick cannot score below 70
};

// ===========================================
// RATING NORMALIZATION MAPPINGS
// ===========================================

// Letter grades → 0-100
export const LETTER_GRADE_MAP: Record<string, number> = {
  'A+': 95,
  'A': 90,
  'A-': 85,
  'B+': 80,
  'B': 76,
  'B-': 72,
  'C+': 67,
  'C': 62,
  'C-': 57,
  'D+': 42,
  'D': 35,
  'D-': 30,
  'F': 20,
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
// AUDIENCE WEIGHTING
// ===========================================
// Actual weighting logic is in scripts/lib/audience-weighting.js:
// All sources (Show Score, Mezzanine, Theatr, Reddit) weighted proportionally
// by review count volume, with 80% cap per source.
// The constants below are kept for backward compatibility (engine.ts import)
// but are NOT used by the active audience scoring pipeline.
/** @deprecated Use scripts/lib/audience-weighting.js instead */
export const AUDIENCE_PLATFORM_WEIGHTS: Record<string, number> = {
  'showscore': 0.50,
  'mezzanine': 0.20,
  'other': 0.10,
};

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
  'Critical Gold': 83,
  'Recommended': 75,
  'Worth Seeing': 65,
  'Skippable': 55,
  'Critical Miss': 0,
};

export function getCriticLabel(score: number): string {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Critical Miss';
}

// ===========================================
// DIVERGENCE THRESHOLDS
// ===========================================
export const AUDIENCE_DIVERGENCE_THRESHOLD = 20;

// ===========================================
// TOP CRITICS (individual critic-level promotion)
// ===========================================
// These critics receive Tier 1 weight and "Top Critic" badge
// regardless of which outlet they write for.
export const TOP_CRITICS: ReadonlySet<string> = new Set([
  'Jesse Green',           // NYT / Vulture (331 reviews)
  'Ben Brantley',          // NYT — retired 2020 (293 reviews)
  'Charles Isherwood',     // WSJ / Variety / Broadway News (379 reviews)
  'David Rooney',          // Hollywood Reporter (341 reviews)
  'Hilton Als',            // New Yorker (15 reviews)
  'Helen Shaw',            // Vulture / New Yorker (87 reviews)
  'Peter Marks',           // Washington Post (262 reviews)
  'Elisabeth Vincentelli', // NY Post → NYT (185 reviews)
  'Adam Feldman',          // Time Out NY (369 reviews)
  'Linda Winer',           // Newsday — retired (280 reviews)
  'Alexis Soloski',        // Guardian → NYT (111 reviews)
  'Sara Holdren',          // Vulture (88 reviews)
  'Johnny Oleksinski',     // NY Post — current since 2017 (136 reviews)
  'Chris Jones',           // Chicago Tribune / NY Daily News (382 reviews)
]);
