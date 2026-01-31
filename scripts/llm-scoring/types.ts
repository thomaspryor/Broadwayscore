/**
 * Type definitions for the LLM-based review scoring system
 */

// ========================================
// INPUT TYPES
// ========================================

/**
 * Review text file from data/review-texts/{show}/{outlet--critic}.json
 */
export interface ReviewTextFile {
  showId: string;
  outletId: string;
  outlet: string;
  criticName: string;
  url: string | null;
  publishDate: string;
  fullText: string | null;
  originalScore: number | null;
  assignedScore: number | null;
  source?: string;
  sourceUrl?: string;
  /** BWW Review Roundup thumb (if available) */
  bwwThumb?: string;
  /** DTLI thumb (if available) */
  dtliThumb?: string;
  /** Original rating string (e.g., "4/5", "B+") */
  originalRating?: string;
  /** BWW excerpt (if available) */
  bwwExcerpt?: string;
  /** DTLI excerpt (if available) */
  dtliExcerpt?: string;
  /** Show Score excerpt (if available) */
  showScoreExcerpt?: string;
  /** Score status marker */
  scoreStatus?: string;
}

/**
 * Review from data/reviews.json
 */
export interface ReviewEntry {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  assignedScore: number;
  originalRating?: string;
  bucket?: string;
  thumb?: string;
  designation?: string;
  pullQuote?: string;
  dtliThumb?: string;
  bwwThumb?: string;
}

// ========================================
// LLM OUTPUT TYPES (V5 - Simplified)
// ========================================

/**
 * Bucket type for review classification
 */
export type Bucket = 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan';

/**
 * Simplified LLM result for v5 scoring (bucket-first approach)
 */
export interface SimplifiedLLMResult {
  /** Sentiment bucket (chosen first, then score within range) */
  bucket: Bucket;
  /** Score within the bucket's range */
  score: number;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** 2-5 word verdict summary */
  verdict: string;
  /** Most indicative quote from the review */
  keyQuote: string;
  /** 1-2 sentence reasoning */
  reasoning: string;
}

/**
 * Individual model score for ensemble
 */
export interface ModelScore {
  model: 'claude' | 'openai' | 'gemini';
  bucket: Bucket;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  verdict?: string;
  keyQuote?: string;
  reasoning?: string;
  error?: string;
}

/**
 * Result from 3-model ensemble scoring
 */
export interface EnsembleResult {
  /** Final score (from ensemble logic) */
  score: number;
  /** Final bucket */
  bucket: Bucket;
  /** Ensemble confidence */
  confidence: 'high' | 'medium' | 'low';
  /** How the score was determined */
  source: 'ensemble-unanimous' | 'ensemble-majority' | 'ensemble-no-consensus' | 'two-model-fallback' | 'single-model-fallback';
  /** Agreement description */
  agreement?: string;
  /** Note about score spread or other details */
  note?: string;
  /** Flag for manual review */
  needsReview?: boolean;
  /** Reason for needing review */
  reviewReason?: string;
  /** Individual model results */
  modelResults: {
    claude?: ModelScore;
    openai?: ModelScore;
    gemini?: ModelScore;
  };
  /** Outlier model if 2/3 agree */
  outlier?: {
    model: string;
    bucket: Bucket;
    score: number;
  };
}

// ========================================
// LLM OUTPUT TYPES (V3 - Legacy, kept for compatibility)
// ========================================

/**
 * Component scores for different aspects of the production
 * @deprecated Use SimplifiedLLMResult instead for v5+
 */
export interface ComponentScores {
  /** Score for book/script/story (0-100) */
  book: number | null;
  /** Score for music/songs if musical (0-100) */
  music: number | null;
  /** Score for performances/acting (0-100) */
  performances: number | null;
  /** Score for direction/design/production (0-100) */
  direction: number | null;
}

/**
 * Key phrase extracted from the review that indicates sentiment
 */
export interface ExtractedPhrase {
  /** The actual quote from the review */
  quote: string;
  /** Whether this phrase is positive, negative, or neutral */
  sentiment: 'positive' | 'negative' | 'neutral';
  /** How strongly this phrase indicates sentiment (1-5) */
  strength: number;
}

/**
 * Full LLM scoring result for a single review
 */
export interface LLMScoringResult {
  /** Overall recommendation strength score (0-100) */
  score: number;

  /** Confidence in the score */
  confidence: 'high' | 'medium' | 'low';

  /** Score range - acknowledges uncertainty */
  range: {
    low: number;
    high: number;
  };

  /** Sentiment bucket for display */
  bucket: 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan';

  /** Thumb rating derived from score */
  thumb: 'Up' | 'Flat' | 'Down';

  /** Component breakdowns (null if not applicable) */
  components: ComponentScores;

  /** 2-3 key phrases that most indicate the review's sentiment */
  keyPhrases: ExtractedPhrase[];

  /** One-sentence justification for the score */
  reasoning: string;

  /** Flags for special conditions */
  flags: {
    /** True if critic gives explicit recommendation/non-recommendation */
    hasExplicitRecommendation: boolean;
    /** True if review is primarily about performances, not the show itself */
    focusedOnPerformances: boolean;
    /** True if review compares to previous productions */
    comparesToPrevious: boolean;
    /** True if we detected conflicting signals in the text */
    mixedSignals: boolean;
  };
}

/**
 * Full output stored alongside the review text file
 */
export interface ScoredReviewFile extends ReviewTextFile {
  /** LLM scoring result (v3 format for backward compatibility) */
  llmScore: LLMScoringResult;
  /** Simplified v5 result (when using v5+ scoring) */
  llmScoreV5?: SimplifiedLLMResult;
  llmMetadata: {
    model: string;
    scoredAt: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    /** Models used (v5: array of model names) */
    models?: string[];
    /** Text source used for scoring */
    textSource?: {
      /** Type of text: 'fullText' or 'excerpt' */
      type: 'fullText' | 'excerpt';
      /** Status: 'complete', 'truncated', 'corrupted', 'curated' */
      status: string;
      /** Which field the text came from */
      field: string;
      /** Confidence level: 'high', 'medium', 'low' */
      confidence: string;
      /** Explanation for why this source was chosen */
      reasoning: string;
    };
    /** Previous score for rollback capability (v5+) */
    previousScore?: number;
    /** Previous prompt version for rollback capability (v5+) */
    previousVersion?: string;
  };
  /** Ensemble scoring data (v5: supports 3 models) */
  ensembleData?: {
    claudeScore: number | null;
    openaiScore: number | null;
    /** Gemini score (v5+) */
    geminiScore?: number | null;
    /** Bucket from each model (v5+) */
    claudeBucket?: Bucket;
    openaiBucket?: Bucket;
    geminiBucket?: Bucket;
    scoreDelta: number;
    thumbsMatch: boolean | null;
    expectedThumb: 'Up' | 'Flat' | 'Down' | null;
    needsReview: boolean;
    needsReviewReasons: string[];
    /** Ensemble source (v5+) */
    ensembleSource?: 'ensemble-unanimous' | 'ensemble-majority' | 'ensemble-no-consensus' | 'two-model-fallback' | 'single-model-fallback';
    /** Model agreement (v5+) */
    modelAgreement?: string;
  };
}

/**
 * Ground truth review - has an actual numeric rating from the critic
 */
export interface GroundTruthReview {
  showId: string;
  outletId: string;
  outlet: string;
  criticName: string;
  /** Original rating string (e.g., "4/5", "B+", "3.5 stars") */
  originalRating: string;
  /** Normalized score (0-100) from the original rating */
  groundTruthScore: number;
  /** Full review text */
  fullText: string;
  /** LLM-generated score (if scored) */
  llmScore?: number;
  /** Ensemble score (if ensemble scored) */
  ensembleScore?: number;
}

// ========================================
// CALIBRATION TYPES
// ========================================

/**
 * A review with both known (human-assigned) and LLM-generated scores
 * Used for calibration
 */
export interface CalibrationDataPoint {
  showId: string;
  outletId: string;
  outlet: string;
  criticName: string;

  /** Human-assigned score from reviews.json */
  humanScore: number;

  /** LLM-generated score */
  llmScore: number;

  /** Delta between scores (llm - human) */
  delta: number;

  /** Absolute error */
  absoluteError: number;

  /** LLM confidence level */
  llmConfidence: 'high' | 'medium' | 'low';

  /** Human-assigned bucket */
  humanBucket?: string;

  /** LLM-assigned bucket */
  llmBucket: string;

  /** Whether buckets match */
  bucketMatch: boolean;
}

/**
 * Calibration statistics for a set of reviews
 */
export interface CalibrationStats {
  /** Total data points analyzed */
  count: number;

  /** Mean Absolute Error */
  mae: number;

  /** Root Mean Square Error */
  rmse: number;

  /** Mean signed error (positive = LLM scores higher) */
  meanBias: number;

  /** Standard deviation of errors */
  stdDev: number;

  /** Percentage of bucket matches */
  bucketAccuracy: number;

  /** Error distribution by confidence level */
  byConfidence: {
    high: { count: number; mae: number };
    medium: { count: number; mae: number };
    low: { count: number; mae: number };
  };

  /** Error distribution by outlet tier */
  byTier?: {
    tier1: { count: number; mae: number; meanBias: number };
    tier2: { count: number; mae: number; meanBias: number };
    tier3: { count: number; mae: number; meanBias: number };
  };

  /** Per-outlet bias (positive = LLM scores this outlet higher) */
  outletBias: Record<string, { count: number; meanBias: number }>;
}

// ========================================
// VALIDATION TYPES
// ========================================

/**
 * Thumbs distribution for a show
 */
export interface ThumbsDistribution {
  up: number;
  flat: number;
  down: number;
  total: number;
}

/**
 * Validation result comparing our scores to aggregator thumbs
 */
export interface AggregatorValidation {
  showId: string;

  /** Our calculated thumbs distribution based on LLM scores */
  ourDistribution: ThumbsDistribution;

  /** DTLI thumbs if available */
  dtliDistribution?: ThumbsDistribution;

  /** BWW thumbs if available */
  bwwDistribution?: ThumbsDistribution;

  /** Show-Score thumbs if available */
  showScoreDistribution?: ThumbsDistribution;

  /** Disagreement flag - true if major disagreement detected */
  hasDisagreement: boolean;

  /** Specific disagreement details */
  disagreementDetails?: string;
}

// ========================================
// PIPELINE TYPES
// ========================================

/**
 * Options for running the scoring pipeline
 */
export interface ScoringPipelineOptions {
  /** Specific show to process (null = all) */
  showId?: string;

  /** Only process reviews without existing scores */
  unscoredOnly: boolean;

  /** Skip reviews with less than N characters of text */
  minTextLength: number;

  /** Claude model to use */
  model: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';

  /** Dry run - don't save results */
  dryRun: boolean;

  /** Verbose logging */
  verbose: boolean;

  /** Maximum reviews to process (null = no limit) */
  limit?: number;

  /** Delay between API calls in ms */
  rateLimitMs: number;

  /** Run calibration after scoring */
  runCalibration: boolean;

  /** Run aggregator validation after scoring */
  runValidation: boolean;
}

/**
 * Summary of a pipeline run
 */
export interface PipelineRunSummary {
  /** When the run started */
  startedAt: string;

  /** When the run completed */
  completedAt: string;

  /** Total reviews found */
  totalReviews: number;

  /** Reviews processed (scored) */
  processed: number;

  /** Reviews skipped (already scored or too short) */
  skipped: number;

  /** Reviews that failed to score */
  errors: number;

  /** Total API tokens used */
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };

  /** Calibration stats if calibration was run */
  calibration?: CalibrationStats;

  /** Validation results if validation was run */
  validation?: AggregatorValidation[];

  /** List of errors */
  errorDetails: Array<{
    showId: string;
    outletId: string;
    error: string;
  }>;
}

// ========================================
// FEW-SHOT EXAMPLE TYPE
// ========================================

/**
 * A calibration example for the LLM prompt
 */
export interface FewShotExample {
  reviewExcerpt: string;
  score: number;
  bucket: string;
  reasoning: string;
}
