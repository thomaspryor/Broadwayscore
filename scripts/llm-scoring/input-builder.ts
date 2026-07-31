/**
 * Input Builder Module
 *
 * Builds rich context for LLM scoring prompts.
 * Adds aggregator data ONLY for truncated texts (with explicit caveat).
 */

import { getOutletTier } from './config';

// Import text quality functions - use require for JS module
const textQuality = require('../lib/text-quality.js');
// Canonical opera discriminator — single source of truth shared with
// classify-wrong-production.js and classify-wrong-show.js. Ship-check P1-C
// (2026-05-17): previously this file inlined `review.type === 'opera'` and
// scripts/lib/opera-prompt-context.js exported its own check; both did the
// same thing but could drift on the first time someone broadens opera
// detection (e.g. to non-Met houses).
const { isOperaShow } = require('../lib/opera-prompt-context');
const { getMarketLabel, isNonMetroMarket, getRegionalPromptContext } = require('../lib/market-label');

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

  // Show context (for cross-market detection)
  category?: string;   // 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end'
  venue?: string;      // e.g. 'Lyric Theatre' or 'Broadhurst Theatre'
  type?: string;       // 'musical' | 'play' | 'special' | 'opera' — opera shows
                       // are stored as category='off-broadway' but framed
                       // separately so the wrong_show check doesn't reject
                       // opera reviews as "not theater"

  // Text sources
  fullText?: string | null;
  bwwExcerpt?: string | null;
  dtliExcerpt?: string | null;
  showScoreExcerpt?: string | null;
  nycTheatreExcerpt?: string | null;
  lboRoundupExcerpt?: string | null;
  westEndTheatreExcerpt?: string | null;
  theatreReviewsExcerpt?: string | null;
  theStageExcerpt?: string | null;
  stagedoorExcerpt?: string | null;
  playbillVerdictExcerpt?: string | null;
  // Allow dynamic excerpt fields from EXCERPT_FIELDS
  [key: string]: any;

  // Aggregator thumbs
  bwwThumb?: string | null;
  dtliThumb?: string | null;

  // BWW editorial score (1-10, assigned by BWW staff)
  bwwScore?: number | null;

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
    // Opera takes precedence over category — Met opera productions are stored
    // with category='off-broadway' but reviews legitimately describe opera, not
    // theater. Framing them as theater causes the ensemble's wrong_show gate
    // to reject every opera review as "not the specified venue/category".
    const isOpera = isOperaShow(review);
    // Market label comes from the shared table (scripts/lib/market-label.js) —
    // the old inline ternary ended in a bare `: 'Broadway'`, so regional
    // tryouts were announced to the model as Broadway productions and both
    // ensemble legs correctly rejected them as wrong_production (2026-07-30).
    const marketLabel = isOpera ? 'Opera (Metropolitan Opera)'
      : getMarketLabel(review.category);
    const venueInfo = review.venue ? ` at ${review.venue}` : '';
    contextParts.push(`Show: ${review.showTitle}${venueInfo} (${marketLabel})`);
    if (!isOpera && isNonMetroMarket(review.category)) {
      contextParts.push(getRegionalPromptContext(review.venue));
    }
    if (isOpera) {
      contextParts.push('NOTE: This is an opera production at the Metropolitan Opera. Reviews discussing opera, the Met, conductors, sopranos/tenors/bass voices, libretto, arias, and musical performance ARE valid for this show — do NOT flag the review as wrong_show or wrong_production for being about opera at the Met.');
    }
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
      const availableExcerpts = textQuality.EXCERPT_FIELDS.map((ef: {field: string}) => (review as any)[ef.field])
        .filter((e: string) => e && e.length >= 30);
      const uniqueExcerpts = new Set(availableExcerpts);
      if (uniqueExcerpts.size === 1) {
        contextParts.push('\n## Single Excerpt Warning');
        contextParts.push('CAUTION: Only ONE excerpt is available from this review. A single curated quote may be cherry-picked and not representative of the overall review sentiment. If the excerpt sounds clearly positive, use the upper end of the bucket (80-84 for Positive). If mildly positive, use the lower end (70-74). Avoid defaulting to 77-78.');
      }
    }
  }

  // 4. Aggregator context (ONLY for non-complete texts)
  const includesAggregatorContext = textQualityStatus !== 'complete' &&
    !!(review.bwwThumb || review.dtliThumb || review.bwwScore != null || textQuality.EXCERPT_FIELDS.some((ef: {field: string}) => (review as any)[ef.field]));

  if (includesAggregatorContext) {
    contextParts.push(`\n## Aggregator Context (for reference only)`);
    contextParts.push('NOTE: Use this context to help identify the likely verdict, but make your own independent assessment based on the review text.');

    // Aggregator thumbs
    const bwwThumb = normalizeThumb(review.bwwThumb);
    const dtliThumb = normalizeThumb(review.dtliThumb);

    if (bwwThumb || dtliThumb || review.bwwScore != null) {
      const thumbsInfo: string[] = [];
      if (dtliThumb) thumbsInfo.push(`Did They Like It: ${dtliThumb}`);
      if (bwwThumb || review.bwwScore != null) {
        const bwwParts: string[] = [];
        if (bwwThumb) bwwParts.push(bwwThumb);
        if (review.bwwScore != null) bwwParts.push(`${review.bwwScore}/10`);
        thumbsInfo.push(`BroadwayWorld: ${bwwParts.join(', ')}`);
      }
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
      const lboExcerpt = review.lboRoundupExcerpt;
      if (lboExcerpt && lboExcerpt !== textResult.text &&
          !excerpts.some(e => e.includes(lboExcerpt))) {
        excerpts.push(`LBO Roundup excerpt: "${lboExcerpt}"`);
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
    const availableExcerpts = textQuality.EXCERPT_FIELDS.map((ef: {field: string}) => (review as any)[ef.field])
      .filter((e: string) => e && e.length >= 30);
    const uniqueExcerpts = new Set(availableExcerpts);
    if (uniqueExcerpts.size <= 1) {
      confidence = 'low';
    }
  }

  // 2E: Force low confidence for SHORT excerpt-only text (DoaS Apr 9-10 #14)
  // Even when multiple excerpts are present, if the actual text being scored is
  // a tiny aggregator fragment (<200 chars from a *Excerpt field), the score
  // is unreliable. Variety was scored 73/Positive from a 180-char BWW excerpt;
  // the full text was actually Mixed (66).
  if (textQualityStatus === 'excerpt-only' && textResult.text && textResult.text.length < 200) {
    confidence = 'low';
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
  if (review.lboRoundupExcerpt && !excerpts.some(e => e === review.lboRoundupExcerpt)) {
    excerpts.push(review.lboRoundupExcerpt);
  }

  return excerpts.join('\n\n');
}
