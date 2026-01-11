// Core data model for Broadway Metascore
// Designed for modular data collection: separate agents can populate each section

// ============================================
// SHOW METADATA (gathered by metadata agent)
// ============================================

export type ShowStatus = 'previews' | 'opened' | 'closing' | 'closed';

export interface ShowMetadata {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string; // ISO date
  closingDate?: string; // ISO date, if announced/known
  status: ShowStatus;
  type: 'musical' | 'play' | 'revival' | 'special';
  runtime?: string; // e.g., "2h 30m"
  intermissions?: number;
}

// ============================================
// CRITIC SCORE (gathered by critics agent)
// ============================================

export type OutletTier = 1 | 2 | 3;

export interface CriticReview {
  outlet: string;
  tier: OutletTier;
  criticName?: string;
  originalRating: string; // The original format: "4/5", "B+", "positive", etc.
  mappedScore: number; // Normalized 0-100
  isInferred: boolean; // True if score was inferred from sentiment
  url: string;
  publishDate: string; // ISO date
  pullQuote?: string; // Optional notable quote
}

export interface CriticScore {
  score: number; // 0-100
  reviewCount: number;
  reviews: CriticReview[];
  lastUpdated: string; // ISO timestamp
  calculationNotes?: string; // Any caveats about the calculation
}

// ============================================
// AUDIENCE SCORE (gathered by audience agent)
// ============================================

export interface AudiencePlatform {
  platform: 'showscore' | 'google' | 'mezzanine' | 'other';
  platformName: string; // Display name
  averageRating: number; // Original scale (e.g., 4.2 for 5-star)
  maxRating: number; // Scale max (e.g., 5)
  mappedScore: number; // Normalized 0-100
  reviewCount?: number; // Sample size if available
  url?: string;
  lastUpdated: string; // ISO timestamp
}

export interface AudienceScore {
  score: number; // 0-100 weighted average
  platforms: AudiencePlatform[];
  totalReviewCount?: number; // Sum of all platform counts
  divergenceWarning?: string; // If platforms disagree significantly
  lastUpdated: string; // ISO timestamp
}

// ============================================
// BUZZ SCORE (gathered by buzz agent)
// ============================================

export interface BuzzThread {
  platform: 'reddit' | 'other';
  subreddit?: string; // e.g., "r/Broadway"
  title: string;
  url: string;
  upvotes: number;
  commentCount: number;
  sentiment: 'positive' | 'mixed' | 'negative';
  date: string; // ISO date
  summary?: string; // Brief summary of discussion
}

export interface BuzzScore {
  score: number; // 0-100
  volumeScore: number; // 0-50 component
  sentimentScore: number; // 0-50 component
  threads: BuzzThread[];
  volumeNote: string; // Explanation of activity level
  sentimentNote: string; // Explanation of sentiment
  lastUpdated: string; // ISO timestamp
  stalenessPenalty?: number; // Penalty applied for old data
}

// ============================================
// QUALITATIVE SUMMARY
// ============================================

export interface QualitativeSummary {
  bullets: string[]; // 3-6 neutral summary bullets
  oneLiner: string; // Quick takeaway for homepage
  generatedAt: string; // ISO timestamp
}

// ============================================
// CONFIDENCE RATING
// ============================================

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Confidence {
  level: ConfidenceLevel;
  reasons: string[]; // Why this confidence level
}

// ============================================
// OVERALL METASCORE
// ============================================

export interface MetascoreWeights {
  critic: number; // Default 0.50
  audience: number; // Default 0.35
  buzz: number; // Default 0.15
}

export interface Metascore {
  score: number; // 0-100 final score
  weights: MetascoreWeights;
  componentScores: {
    critic: number;
    audience: number;
    buzz: number;
  };
  calculatedAt: string; // ISO timestamp
}

// ============================================
// COMPLETE SHOW RECORD
// ============================================

export interface Show {
  // Metadata
  metadata: ShowMetadata;

  // Score components (each can be populated independently)
  criticScore?: CriticScore;
  audienceScore?: AudienceScore;
  buzzScore?: BuzzScore;

  // Computed overall
  metascore?: Metascore;

  // Qualitative
  summary?: QualitativeSummary;

  // Confidence assessment
  confidence?: Confidence;

  // Record tracking
  createdAt: string; // ISO timestamp
  lastUpdated: string; // ISO timestamp
}

// ============================================
// HELPER TYPE FOR HOMEPAGE DISPLAY
// ============================================

export interface ShowListItem {
  id: string;
  title: string;
  slug: string;
  venue: string;
  status: ShowStatus;
  criticScore?: number;
  audienceScore?: number;
  buzzScore?: number;
  metascore?: number;
  confidence?: ConfidenceLevel;
  oneLiner?: string;
  openingDate: string;
}

// ============================================
// OUTLET TIER DEFINITIONS
// ============================================

export const OUTLET_TIERS: Record<string, OutletTier> = {
  // Tier 1: Major national publications
  'The New York Times': 1,
  'Vulture': 1,
  'Variety': 1,
  'The Hollywood Reporter': 1,
  'Time Out New York': 1,
  'The Washington Post': 1,

  // Tier 2: Major theatre-focused outlets
  'TheaterMania': 2,
  'Broadway News': 2,
  'BroadwayWorld': 2,
  'New York Magazine': 2,
  'Entertainment Weekly': 2,
  'The Guardian': 2,
  'Associated Press': 2,

  // Tier 3: Smaller outlets / blogs
  // Default tier for unlisted outlets
};

export const DEFAULT_WEIGHTS: MetascoreWeights = {
  critic: 0.50,
  audience: 0.35,
  buzz: 0.15,
};
