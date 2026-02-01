/**
 * Input Builder Module
 *
 * Builds rich context for LLM scoring prompts.
 * Adds aggregator data ONLY for truncated texts (with explicit caveat).
 */

import { getOutletTier } from './config';

// Import text quality functions - use require for JS module
const textQuality = require('../lib/text-quality.js');

// ========================================
// TYPES
// ========================================

export interface ReviewInputData {
  // Review metadata
  showId?: string;
  showTitle?: string;
  outletId?: string;
  outlet?: string;
  criticName?: string;
  publishDate?: string;

  // Text sources
  fullText?: string | null;
  bwwExcerpt?: string | null;
  dtliExcerpt?: string | null;
  showScoreExcerpt?: string | null;
  nycTheatreExcerpt?: string | null;

  // Aggregator thumbs
  bwwThumb?: string | null;
  dtliThumb?: string | null;

  // Original rating (if present)
  originalScore?: string | null;
  originalRating?: string | null;
}

export interface ScoringInput {
  text: string;
  context: string;
  textQuality: 'complete' | 'truncated' | 'corrupted' | 'excerpt-only';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  includesAggregatorContext: boolean;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Map thumbs to consistent format
 */
function normalizeThumb(thumb: string | null | undefined): 'Up' | 'Flat' | 'Down' | null {
  if (!thumb) return null;

  const thumbMap: Record<string, 'Up' | 'Flat' | 'Down'> = {
    'Up': 'Up',
    'Rave': 'Up',
    'Positive': 'Up',
    'Fresh': 'Up',
    'Flat': 'Flat',
    'Mixed': 'Flat',
    'Meh': 'Flat',
    'Down': 'Down',
    'Pan': 'Down',
    'Negative': 'Down',
    'Rotten': 'Down'
  };

  return thumbMap[thumb] || null;
}

/**
 * Get tier display name
 */
function getTierName(tier: number): string {
  switch (tier) {
    case 1: return 'Tier 1 (major publication)';
    case 2: return 'Tier 2 (notable outlet)';
    case 3: return 'Tier 3 (smaller outlet)';
    default: return 'Unknown tier';
  }
}

// ========================================
// MAIN FUNCTION
// ========================================

/**
 * Build rich context for LLM scoring
 *
 * For complete fullText: Uses just the text
 * For truncated/corrupted fullText: Adds aggregator context with caveat
 * For excerpt-only: Uses excerpts with appropriate framing
 */
export function buildScoringInput(review: ReviewInputData): ScoringInput {
  // Use text-quality module to find best text source
  const textResult = textQuality.getBestTextForScoring(review);

  // Early exit if no usable text
  if (!textResult.text || textResult.status === 'insufficient') {
    return {
      text: '',
      context: '',
      textQuality: 'excerpt-only',
      confidence: 'none' as any,
      reasoning: 'No usable text found',
      includesAggregatorContext: false
    };
  }

  // Determine text quality status
  let textQualityStatus: 'complete' | 'truncated' | 'corrupted' | 'excerpt-only';
  if (textResult.type === 'fullText') {
    textQualityStatus = textResult.status as 'complete' | 'truncated' | 'corrupted';
  } else {
    textQualityStatus = 'excerpt-only';
  }

  // Build context parts
  const contextParts: string[] = [];

  // 1. Metadata context
  if (review.outlet || review.outletId) {
    const tier = review.outletId ? getOutletTier(review.outletId) : 3;
    contextParts.push(`## Outlet: ${review.outlet || review.outletId} (${getTierName(tier)})`);
  }

  if (review.criticName) {
    contextParts.push(`Critic: ${review.criticName}`);
  }

  if (review.showTitle) {
    contextParts.push(`Show: ${review.showTitle}`);
  }

  // 2. Original rating (if present)
  const originalRating = review.originalRating || review.originalScore;
  if (originalRating) {
    contextParts.push(`\n## Original Rating: ${originalRating}`);
    contextParts.push('NOTE: The critic\'s own rating should heavily influence the bucket classification.');
  }

  // 3. Text quality warning (for non-complete texts)
  if (textQualityStatus !== 'complete') {
    contextParts.push(`\n## Text Quality Warning`);

    if (textQualityStatus === 'truncated') {
      contextParts.push('IMPORTANT: This review text appears to be TRUNCATED (cut off before the end).');
      contextParts.push('The critic\'s final verdict may be missing. Be cautious about assigning negative scores.');
      contextParts.push(`Assessment reason: ${textResult.reasoning}`);
    } else if (textQualityStatus === 'corrupted') {
      contextParts.push('IMPORTANT: This review text contains artifacts or corruption.');
      contextParts.push('Some content may be website navigation, photo credits, or other non-review text.');
      contextParts.push(`Assessment reason: ${textResult.reasoning}`);
    } else if (textQualityStatus === 'excerpt-only') {
      contextParts.push('IMPORTANT: Only curated excerpts are available (no full review text).');
      contextParts.push('These are selected quotes from the review and may not represent the full verdict.');

      // 2D: Count available unique excerpts for single-excerpt warning
      const availableExcerpts = [review.bwwExcerpt, review.dtliExcerpt, review.showScoreExcerpt, review.nycTheatreExcerpt]
        .filter(e => e && e.length >= 30);
      const uniqueExcerpts = new Set(availableExcerpts);
      if (uniqueExcerpts.size === 1) {
        contextParts.push('\n## Single Excerpt Warning');
        contextParts.push('CAUTION: Only ONE excerpt is available from this review. A single curated quote may be cherry-picked and not representative of the overall review sentiment. Score conservatively toward the middle of the chosen bucket range.');
      }
    }
  }

  // 4. Aggregator context (ONLY for non-complete texts)
  const includesAggregatorContext = textQualityStatus !== 'complete' &&
    !!(review.bwwThumb || review.dtliThumb || review.bwwExcerpt || review.dtliExcerpt || review.showScoreExcerpt || review.nycTheatreExcerpt);

  if (includesAggregatorContext) {
    contextParts.push(`\n## Aggregator Context (for reference only)`);
    contextParts.push('NOTE: Use this context to help identify the likely verdict, but make your own independent assessment based on the review text.');

    // Aggregator thumbs
    const bwwThumb = normalizeThumb(review.bwwThumb);
    const dtliThumb = normalizeThumb(review.dtliThumb);

    if (bwwThumb || dtliThumb) {
      const thumbsInfo: string[] = [];
      if (dtliThumb) thumbsInfo.push(`Did They Like It: ${dtliThumb}`);
      if (bwwThumb) thumbsInfo.push(`BroadwayWorld: ${bwwThumb}`);
      contextParts.push(`Aggregator verdicts: ${thumbsInfo.join(', ')}`);
    }

    // Additional excerpts (if we're not already using them as main text)
    if (textQualityStatus === 'truncated' || textQualityStatus === 'corrupted') {
      const excerpts: string[] = [];

      if (review.showScoreExcerpt && review.showScoreExcerpt !== textResult.text) {
        excerpts.push(`Show Score excerpt: "${review.showScoreExcerpt}"`);
      }
      if (review.dtliExcerpt && review.dtliExcerpt !== textResult.text && review.dtliExcerpt !== review.showScoreExcerpt) {
        excerpts.push(`DTLI excerpt: "${review.dtliExcerpt}"`);
      }
      if (review.bwwExcerpt && review.bwwExcerpt !== textResult.text && review.bwwExcerpt !== review.dtliExcerpt && review.bwwExcerpt !== review.showScoreExcerpt) {
        excerpts.push(`BWW excerpt: "${review.bwwExcerpt}"`);
      }

      if (excerpts.length > 0) {
        contextParts.push('\nAdditional curated excerpts from this review:');
        contextParts.push(excerpts.join('\n'));
      }
    }
  }

  // Determine confidence based on text quality
  let confidence: 'high' | 'medium' | 'low';
  if (textQualityStatus === 'complete') {
    confidence = 'high';
  } else if (textQualityStatus === 'excerpt-only' || (textQualityStatus === 'truncated' && includesAggregatorContext)) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // 2D: Force low confidence for single-excerpt scoring
  if (textQualityStatus === 'excerpt-only') {
    const availableExcerpts = [review.bwwExcerpt, review.dtliExcerpt, review.showScoreExcerpt, review.nycTheatreExcerpt]
      .filter(e => e && e.length >= 30);
    const uniqueExcerpts = new Set(availableExcerpts);
    if (uniqueExcerpts.size <= 1) {
      confidence = 'low';
    }
  }

  return {
    text: textResult.text,
    context: contextParts.join('\n'),
    textQuality: textQualityStatus,
    confidence,
    reasoning: textResult.reasoning,
    includesAggregatorContext
  };
}

/**
 * Build combined excerpts from multiple sources
 */
export function combineExcerpts(review: ReviewInputData): string {
  const excerpts: string[] = [];

  if (review.showScoreExcerpt) excerpts.push(review.showScoreExcerpt);
  if (review.dtliExcerpt && review.dtliExcerpt !== review.showScoreExcerpt) {
    excerpts.push(review.dtliExcerpt);
  }
  if (review.bwwExcerpt && review.bwwExcerpt !== review.showScoreExcerpt && review.bwwExcerpt !== review.dtliExcerpt) {
    excerpts.push(review.bwwExcerpt);
  }
  if (review.nycTheatreExcerpt && review.nycTheatreExcerpt !== review.showScoreExcerpt &&
      review.nycTheatreExcerpt !== review.dtliExcerpt && review.nycTheatreExcerpt !== review.bwwExcerpt) {
    excerpts.push(review.nycTheatreExcerpt);
  }

  return excerpts.join('\n\n');
}
