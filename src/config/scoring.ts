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
export const SCORE_DISPLAY_YEAR_CUTOFF = 2005;
export const MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF = 3;
export const LOW_CONF_SCORE_SOURCES = new Set([
  'llmScore-lowconf',
  'llmScore-thumb-boosted',
  'thumb',
  'bwwScore-fallback',
]);

/** Returns true if a show's reviews should be completely hidden on the site. */
export function shouldHideReviews(show: { openingDate?: string | null; status?: string; category?: string }): boolean {
  if (!show.openingDate) return false;
  const openingYear = new Date(show.openingDate).getFullYear();
  if (openingYear >= SCORE_DISPLAY_YEAR_CUTOFF) return false;
  // Still-open shows were explicitly collected — show their reviews
  if (show.status === 'open' || show.status === 'previews') return false;
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
// to ensure our scoring approach is uniquely calibrated for Broadway
export const TIER_WEIGHTS = {
  1: 1.0,
  2: 0.75,
  3: 0.35,
} as const;

export const DEFAULT_TIER = 3 as const;

// Outlet ID → Tier mapping (keys are canonical lowercase registry IDs)
export const OUTLET_TIERS: Record<string, { tier: 1 | 2 | 3; name: string; scoreFormat: string; maxScale?: number }> = {
  // Tier 1: Major national publications & top culture sites
  'nytimes': { tier: 1, name: 'The New York Times', scoreFormat: 'text_bucket' },
  'washpost': { tier: 1, name: 'The Washington Post', scoreFormat: 'text_bucket' },
  'latimes': { tier: 1, name: 'Los Angeles Times', scoreFormat: 'text_bucket' },
  'wsj': { tier: 1, name: 'The Wall Street Journal', scoreFormat: 'text_bucket' },
  'ap': { tier: 1, name: 'Associated Press', scoreFormat: 'text_bucket' },
  'variety': { tier: 1, name: 'Variety', scoreFormat: 'text_bucket' },
  'hollywood-reporter': { tier: 1, name: 'The Hollywood Reporter', scoreFormat: 'text_bucket' },
  'vulture': { tier: 1, name: 'Vulture', scoreFormat: 'text_bucket' },
  'guardian': { tier: 1, name: 'The Guardian', scoreFormat: 'stars', maxScale: 5 },
  'timeout': { tier: 1, name: 'Time Out New York', scoreFormat: 'stars', maxScale: 5 },
  'broadwaynews': { tier: 1, name: 'Broadway News', scoreFormat: 'text_bucket' },
  'newyorker': { tier: 1, name: 'The New Yorker', scoreFormat: 'text_bucket' },

  // Tier 2: Regional papers, trades, theatre-specific outlets
  'chicagotribune': { tier: 2, name: 'Chicago Tribune', scoreFormat: 'text_bucket' },
  'usatoday': { tier: 2, name: 'USA Today', scoreFormat: 'text_bucket' },
  'nydailynews': { tier: 2, name: 'New York Daily News', scoreFormat: 'text_bucket' },
  'nypost': { tier: 2, name: 'New York Post', scoreFormat: 'text_bucket' },
  'thewrap': { tier: 2, name: 'The Wrap', scoreFormat: 'text_bucket' },
  'ew': { tier: 2, name: 'Entertainment Weekly', scoreFormat: 'letter' },
  'indiewire': { tier: 2, name: 'IndieWire', scoreFormat: 'text_bucket' },
  'deadline': { tier: 2, name: 'Deadline', scoreFormat: 'text_bucket' },
  'slantmagazine': { tier: 2, name: 'Slant Magazine', scoreFormat: 'stars', maxScale: 4 },
  'dailybeast': { tier: 2, name: 'The Daily Beast', scoreFormat: 'text_bucket' },
  'observer': { tier: 2, name: 'Observer', scoreFormat: 'text_bucket' },
  'nyt-theater': { tier: 2, name: 'New York Theater', scoreFormat: 'text_bucket' },
  'nytg': { tier: 2, name: 'New York Theatre Guide', scoreFormat: 'text_bucket' },
  'nysr': { tier: 2, name: 'New York Stage Review', scoreFormat: 'text_bucket' },
  'theatermania': { tier: 2, name: 'TheaterMania', scoreFormat: 'text_bucket' },
  'theatrely': { tier: 2, name: 'Theatrely', scoreFormat: 'text_bucket' },

  // Tier 2 - Additional national/regional outlets
  'newsday': { tier: 2, name: 'Newsday', scoreFormat: 'text_bucket' },
  'time': { tier: 2, name: 'TIME', scoreFormat: 'text_bucket' },
  'rollingstone': { tier: 2, name: 'Rolling Stone', scoreFormat: 'text_bucket' },
  'bloomberg': { tier: 2, name: 'Bloomberg', scoreFormat: 'text_bucket' },
  'vox': { tier: 2, name: 'Vox', scoreFormat: 'text_bucket' },
  'slate': { tier: 2, name: 'Slate', scoreFormat: 'text_bucket' },
  'people': { tier: 2, name: 'People', scoreFormat: 'text_bucket' },
  'parade': { tier: 2, name: 'Parade', scoreFormat: 'text_bucket' },
  'billboard': { tier: 2, name: 'Billboard', scoreFormat: 'text_bucket' },
  'huffpost': { tier: 2, name: 'HuffPost', scoreFormat: 'text_bucket' },
  'backstage': { tier: 2, name: 'Backstage', scoreFormat: 'text_bucket' },
  'village-voice': { tier: 2, name: 'The Village Voice', scoreFormat: 'text_bucket' },
  'financialtimes': { tier: 1, name: 'Financial Times', scoreFormat: 'text_bucket' },
  'philadelphia-inquirer': { tier: 2, name: 'The Philadelphia Inquirer', scoreFormat: 'text_bucket' },
  'chicago-sun-times': { tier: 2, name: 'Chicago Sun-Times', scoreFormat: 'text_bucket' },
  'new-york-sun': { tier: 2, name: 'The New York Sun', scoreFormat: 'text_bucket' },

  // Tier 2 — Promoted from T3 (Feb 27 tier audit: professional journalism outlets)
  'amny': { tier: 2, name: 'amNewYork', scoreFormat: 'text_bucket' },
  'talkinbroadway': { tier: 2, name: "Talkin' Broadway", scoreFormat: 'text_bucket' },
  'ny1': { tier: 2, name: 'NY1', scoreFormat: 'text_bucket' },
  'nbcny': { tier: 2, name: 'NBC New York', scoreFormat: 'text_bucket' },
  'curtainup': { tier: 2, name: 'CurtainUp', scoreFormat: 'text_bucket' },
  'northjerseycom': { tier: 2, name: 'NorthJersey.com', scoreFormat: 'text_bucket' },
  'njcom': { tier: 2, name: 'NJ.com', scoreFormat: 'text_bucket' },
  // bergen-record merged into northjerseycom (same outlet, renamed)
  'wnyc': { tier: 2, name: 'WNYC', scoreFormat: 'text_bucket' },

  // === LONDON / WEST END OUTLETS ===
  // Tier 1 — Major UK nationals + industry trade
  'times-uk': { tier: 1, name: 'The Times (UK)', scoreFormat: 'stars', maxScale: 5 },
  'telegraph': { tier: 1, name: 'The Telegraph', scoreFormat: 'stars', maxScale: 5 },
  'standard': { tier: 1, name: 'Evening Standard', scoreFormat: 'stars', maxScale: 5 },
  'thestage': { tier: 1, name: 'The Stage', scoreFormat: 'stars', maxScale: 5 },
  'timeout-london': { tier: 1, name: 'Time Out London', scoreFormat: 'stars', maxScale: 5 },
  // Note: guardian already listed in US Tier 1 — covers both Broadway and West End
  // Note: financialtimes listed in US section as Tier 1 — covers both Broadway and West End

  // Tier 2 — UK specialist/consumer
  'daily-mail': { tier: 2, name: 'Daily Mail', scoreFormat: 'stars', maxScale: 5 },
  'whatsonstage': { tier: 2, name: 'WhatsOnStage', scoreFormat: 'stars', maxScale: 5 },
  'independent': { tier: 2, name: 'The Independent', scoreFormat: 'stars', maxScale: 5 },
  'london-theatre': { tier: 2, name: 'London Theatre', scoreFormat: 'stars', maxScale: 5 },
  'i-paper': { tier: 2, name: 'The i', scoreFormat: 'stars', maxScale: 5 },
  'artsdesk': { tier: 2, name: 'The Arts Desk', scoreFormat: 'stars', maxScale: 5 },

  // Tier 3: Smaller outlets, blogs, niche sites
  'cititour': { tier: 3, name: 'Cititour', scoreFormat: 'text_bucket' },
  'culturesauce': { tier: 3, name: 'Culture Sauce', scoreFormat: 'stars', maxScale: 5 },
  'frontmezzjunkies': { tier: 3, name: 'Front Mezz Junkies', scoreFormat: 'text_bucket' },
  'the-recs': { tier: 3, name: 'The Recs', scoreFormat: 'text_bucket' },
  'one-minute-critic': { tier: 3, name: 'One Minute Critic', scoreFormat: 'stars', maxScale: 5 },
  'broadwayworld': { tier: 3, name: 'BroadwayWorld', scoreFormat: 'text_bucket' },
  'stageandcinema': { tier: 3, name: 'Stage and Cinema', scoreFormat: 'text_bucket' },
  'theater-scene': { tier: 3, name: 'TheaterScene', scoreFormat: 'text_bucket' },
  'stagezine': { tier: 3, name: 'StageZine', scoreFormat: 'text_bucket' },
  'mashable': { tier: 3, name: 'Mashable', scoreFormat: 'text_bucket' },
  'queerty': { tier: 3, name: 'Queerty', scoreFormat: 'text_bucket' },
  'medium': { tier: 3, name: 'Medium', scoreFormat: 'text_bucket' },
  'exeunt-magazine': { tier: 3, name: 'Exeunt Magazine', scoreFormat: 'text_bucket' },
  'towleroad': { tier: 3, name: 'Towleroad', scoreFormat: 'text_bucket' },
  'forward': { tier: 3, name: 'The Forward', scoreFormat: 'text_bucket' },
  'fort-worth-star-telegram': { tier: 3, name: 'Fort Worth Star-Telegram', scoreFormat: 'text_bucket' },
  'new-jersey-newsroom': { tier: 3, name: 'NJ Newsroom', scoreFormat: 'text_bucket' },
  'theater-news-online': { tier: 3, name: 'Theater News Online', scoreFormat: 'text_bucket' },
};

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
  'Stay Away': 0,
};

export function getCriticLabel(score: number): string {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Stay Away';
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
