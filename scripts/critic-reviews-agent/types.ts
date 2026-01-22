/**
 * Type definitions for the Critic Reviews Agent
 */

// Raw review data as fetched from sources
export interface RawReview {
  source: string; // Which aggregator/outlet this came from
  outletName: string;
  criticName?: string;
  url?: string;
  publishDate?: string;
  originalRating?: string; // Raw rating string (e.g., "B+", "4/5", "Rave")
  ratingType?: 'letter' | 'stars' | 'numeric' | 'bucket' | 'thumb' | 'text';
  maxScale?: number; // For star/numeric ratings
  excerpt?: string;
  designation?: string; // Critics_Pick, etc.
}

// Normalized review ready for output
export interface NormalizedReview {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url?: string;
  publishDate?: string;
  assignedScore: number; // 0-100
  originalRating?: string;
  bucket: 'Rave' | 'Positive' | 'Mixed' | 'Pan';
  thumb: 'Up' | 'Flat' | 'Down';
  designation?: string;
  pullQuote?: string;
}

// Configuration for an outlet
export interface OutletConfig {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  aliases: string[]; // Different names the outlet might appear as
  domain?: string; // Primary domain for URL matching
  scoreFormat: 'letter' | 'stars' | 'numeric' | 'text_bucket' | 'thumb';
  maxScale?: number;
  reviewUrlPattern?: RegExp;
  // For direct outlet fetching
  searchUrl?: (showTitle: string) => string; // URL to search for show reviews
  reviewsSection?: string; // CSS selector or section identifier for reviews
  enabled?: boolean; // Whether to include in direct fetching (default: true)
}

// Configuration for an aggregator source
export interface AggregatorConfig {
  name: string;
  baseUrl: string;
  showUrlPattern: (showTitle: string) => string;
  parseReviews: (html: string, showTitle: string) => RawReview[];
}

// Agent run options
export interface AgentOptions {
  showId?: string; // Specific show to process
  showTitle?: string; // Show title for searching
  dryRun?: boolean; // Don't write output
  verbose?: boolean; // Extra logging
  sources?: string[]; // Which sources to fetch from
}

// Agent result
export interface AgentResult {
  showId: string;
  showTitle: string;
  reviewsFound: NormalizedReview[];
  newReviews: NormalizedReview[];
  updatedReviews: NormalizedReview[];
  skippedDuplicates: number;
  errors: string[];
  sources: string[];
}

// Review match for deduplication
export interface ReviewMatch {
  outletId: string;
  criticName?: string;
  url?: string;
  matchType: 'exact_url' | 'outlet_critic' | 'outlet_only';
}
