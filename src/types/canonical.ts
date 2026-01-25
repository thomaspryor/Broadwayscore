/**
 * Canonical Types for Broadway Scorecard
 *
 * This file defines the authoritative interfaces for all data in the system.
 * All sessions and scripts should import types from here.
 *
 * ID Formats:
 * - Show: "{title-slug}-{year}" e.g., "two-strangers-bway-2025"
 * - Outlet: uppercase ID e.g., "NYT", "VULT", "THR"
 * - Review: "{showId}--{outletId}--{criticSlug}" e.g., "two-strangers-bway-2025--NYT--laura-collins-hughes"
 * - ReviewSource: "{source}--{sourceKey}" e.g., "dtli--two-strangers"
 * - ReviewText: "{reviewId}--{textSource}" e.g., "two-strangers-bway-2025--NYT--laura-collins-hughes--scraped"
 */

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Convert a name/title to a URL-safe slug
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, '')           // Remove apostrophes
    .replace(/[^a-z0-9]+/g, '-')    // Replace non-alphanumeric with dashes
    .replace(/(^-|-$)/g, '');       // Remove leading/trailing dashes
}

/**
 * Generate a canonical review ID
 */
export function generateReviewId(showId: string, outletId: string, criticName?: string): string {
  const criticSlug = criticName ? slugify(criticName) : 'unknown';
  return `${showId}--${outletId}--${criticSlug}`;
}

/**
 * Parse a review ID into its components
 */
export function parseReviewId(reviewId: string): { showId: string; outletId: string; criticSlug: string } | null {
  const parts = reviewId.split('--');
  if (parts.length !== 3) return null;
  return {
    showId: parts[0],
    outletId: parts[1],
    criticSlug: parts[2],
  };
}

/**
 * Generate a review source ID
 */
export function generateSourceId(source: ReviewSourceType, sourceKey: string): string {
  return `${source}--${sourceKey}`;
}

/**
 * Generate a review text ID
 */
export function generateTextId(reviewId: string, textSource: TextSource): string {
  return `${reviewId}--${textSource}`;
}

// ===========================================
// CORE ENUMS & TYPES
// ===========================================

export type ShowStatus = 'previews' | 'opened' | 'closing' | 'closed';
export type ShowType = 'musical' | 'play' | 'revival' | 'special';
export type OutletTier = 1 | 2 | 3;
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Score bucket labels */
export type ScoreBucket = 'must-see' | 'recommended' | 'worth-seeing' | 'skippable' | 'stay-away' | 'pending';

/** Thumb values from aggregators */
export type ThumbValue = 'Up' | 'Flat' | 'Down';

/** Sentiment classification */
export type SentimentBucket = 'Rave' | 'Positive' | 'mixed-positive' | 'mixed-neutral' | 'Mixed' | 'mixed-negative' | 'Negative' | 'Pan';

/** Sources for review data */
export type ReviewSourceType = 'dtli' | 'show-score' | 'bww' | 'manual';

/** Sources for review text */
export type TextSource = 'scraped' | 'webfetch' | 'manual' | 'excerpt-only';

/** Validation status for review text */
export type ValidationStatus = 'validated' | 'pending' | 'failed' | 'partial';

// ===========================================
// SHOW INTERFACE
// ===========================================

export interface ShowImages {
  hero?: string;        // Full-width hero image (1920x1080 or similar)
  thumbnail?: string;   // Square thumbnail (400x400)
  poster?: string;      // Poster image (2:3 ratio)
}

export interface TicketLink {
  platform: string;     // TodayTix, Telecharge, Official, etc.
  url: string;
  priceFrom?: number;   // Starting price in dollars
}

export interface CastMember {
  name: string;
  role: string;         // Character name or "Ensemble"
}

export interface CreativeMember {
  name: string;
  role: string;         // Director, Book, Music, Lyrics, Choreographer, etc.
}

export interface Show {
  // Core identification
  id: string;                     // e.g., "two-strangers-bway-2025"
  title: string;                  // e.g., "Two Strangers (Carry a Cake Across New York)"
  slug: string;                   // URL slug, often matches id

  // Venue & dates
  venue: string;
  openingDate: string;            // ISO date
  closingDate: string | null;     // ISO date, null if open-ended
  status: ShowStatus;

  // Classification
  type: ShowType;
  tags?: string[];                // Musical, Comedy, Romance, New, etc.

  // Details
  runtime: string;                // e.g., "2h 30m"
  intermissions?: number;
  synopsis?: string;
  ageRecommendation?: string;     // e.g., "Ages 12+", "All ages"
  limitedRun?: boolean;           // true for shows with announced closing dates

  // Media
  images?: ShowImages;
  officialUrl?: string;
  trailerUrl?: string;

  // Cast & creative
  cast?: CastMember[];
  creativeTeam?: CreativeMember[];

  // Tickets
  ticketLinks?: TicketLink[];
  theaterAddress?: string;
}

// ===========================================
// OUTLET INTERFACE
// ===========================================

export type ScoreFormat = 'text_bucket' | 'letter' | 'stars' | 'numeric' | 'percentage';

export interface Outlet {
  id: string;                     // e.g., "NYT", "VULT"
  name: string;                   // e.g., "The New York Times"
  tier: OutletTier;
  weight: number;                 // Derived from tier: 1.0, 0.85, 0.70
  url?: string;                   // Publication homepage
  aliases?: string[];             // Alternative names used by aggregators
  scoreFormat: ScoreFormat;
  maxScale?: number;              // For star ratings: 4, 5, etc.
  isActive: boolean;              // Whether we currently track this outlet
}

// ===========================================
// REVIEW INTERFACE (Canonical)
// ===========================================

export interface Review {
  // Identification
  id: string;                     // "{showId}--{outletId}--{criticSlug}"
  showId: string;
  outletId: string;
  outlet: string;                 // Display name
  criticName?: string;
  criticSlug?: string;

  // Publication info
  url: string;
  publishDate: string;            // ISO date or descriptive (e.g., "November 20, 2025")

  // Scoring
  originalRating?: string;        // Original format: "B+", "4/5", "Rave"
  assignedScore: number;          // 0-100 normalized score
  bucket?: SentimentBucket;       // Sentiment classification
  thumb?: ThumbValue;             // From aggregators
  designation?: string;           // Critics_Pick, Critics_Choice, etc.

  // Tier info
  tier: OutletTier;
  tierWeight: number;

  // Display
  quote?: string;                 // Direct quote from the review
  summary?: string;               // Third-person summary

  // Metadata
  sources: ReviewSourceType[];    // Where this review was discovered
  lastUpdated: string;            // ISO timestamp
}

// ===========================================
// REVIEW SOURCE (Aggregator Evidence)
// ===========================================

export interface ReviewSource {
  // Identification
  id: string;                     // "{source}--{sourceKey}"
  source: ReviewSourceType;       // dtli, show-score, bww
  sourceKey: string;              // Aggregator's identifier

  // Show mapping
  showId: string;

  // Aggregator-specific data
  aggregatorUrl: string;
  archivePath?: string;           // Local archive file path

  // Extracted data
  reviewCount: number;
  reviews: AggregatorReview[];

  // Audience data (if available)
  audienceScore?: number;
  audienceReviewCount?: number;

  // Metadata
  fetchedAt: string;              // When we fetched this
  extractedAt?: string;           // When we extracted data
}

export interface AggregatorReview {
  outlet: string;
  criticName?: string;
  date?: string;
  excerpt?: string;
  url?: string;
  thumb?: ThumbValue;             // DTLI thumbs
  score?: number;                 // If aggregator provides a score
}

// ===========================================
// REVIEW TEXT
// ===========================================

export interface ReviewText {
  // Identification
  id: string;                     // "{reviewId}--{textSource}"
  reviewId: string;

  // Content
  fullText: string | null;        // Complete review text, null if only excerpts
  isFullReview: boolean;          // True if fullText is complete (500+ chars)

  // Excerpts from aggregators
  dtliExcerpt?: string;
  bwwExcerpt?: string;
  showScoreExcerpt?: string;

  // Source info
  textSource: TextSource;         // How we got the text
  sourceUrl: string;

  // Validation
  validationStatus: ValidationStatus;
  validationNotes?: string;

  // Metadata
  fetchedAt: string;
  wordCount?: number;
}

// ===========================================
// LLM SCORE (Sentiment Analysis Results)
// ===========================================

export interface LLMScore {
  reviewId: string;

  // Scoring results
  sentimentScore: number;         // 0-100
  confidence: number;             // 0-1
  reasoning: string;              // LLM's explanation

  // Classification
  bucket: SentimentBucket;

  // Model info
  model: string;                  // e.g., "claude-3-haiku"
  promptVersion: string;          // Version of the prompt used

  // Metadata
  scoredAt: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ===========================================
// COMPUTED TYPES (for display/aggregation)
// ===========================================

export interface ComputedCriticScore {
  score: number;                  // Simple average of reviewMetaScores
  weightedScore: number;          // Weighted average using tier weights
  reviewCount: number;
  tier1Count: number;
  label: string;                  // Rave, Positive, Mixed, Negative
  reviews: Review[];
}

export interface ComputedShow extends Show {
  criticScore: ComputedCriticScore | null;
  metascore: number | null;
  scoreBucket: ScoreBucket;
  confidence: ConfidenceLevel;
  methodologyVersion: string;
  computedAt: string;
}

// ===========================================
// FILE STRUCTURE TYPES
// ===========================================

/** Structure of data/reviews/by-show/{showId}.json */
export interface ShowReviewsFile {
  showId: string;
  lastUpdated: string;
  reviewCount: number;
  reviews: Review[];
}

/** Structure of data/review-sources/{source}/{showId}.json */
export interface ReviewSourceFile {
  showId: string;
  source: ReviewSourceType;
  lastUpdated: string;
  data: ReviewSource;
}

/** Structure of data/review-texts/{showId}/{reviewId}.json */
export interface ReviewTextFile {
  reviewId: string;
  showId: string;
  lastUpdated: string;
  data: ReviewText;
}

/** Structure of data/llm-scores/{showId}.json */
export interface LLMScoresFile {
  showId: string;
  lastUpdated: string;
  scores: LLMScore[];
}

// ===========================================
// UTILITY TYPES
// ===========================================

/** Reconciliation result between sources */
export interface ReconciliationResult {
  showId: string;
  reconciledAt: string;
  sources: {
    dtli?: { reviewCount: number; lastFetched: string };
    showScore?: { reviewCount: number; lastFetched: string };
    bww?: { reviewCount: number; lastFetched: string };
  };
  canonical: {
    reviewCount: number;
    missingFromSources: string[];  // Review IDs we have that sources don't
    notYetAdded: string[];         // Reviews in sources we haven't added
  };
  discrepancies: string[];         // Human-readable discrepancy notes
}

/** Validation report for a show */
export interface ValidationReport {
  showId: string;
  validatedAt: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalReviews: number;
    withFullText: number;
    withExcerptOnly: number;
    withLLMScore: number;
    tier1Count: number;
    tier2Count: number;
    tier3Count: number;
  };
}
