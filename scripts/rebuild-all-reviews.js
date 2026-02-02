#!/usr/bin/env node
/**
 * Rebuild reviews.json from ALL review-texts data
 *
 * IMPORTANT: Reviews WITHOUT a valid score source are EXCLUDED
 * We NEVER use a default score of 50 - that skews results
 *
 * Score priority (in order):
 * P0a. EXPLICIT RATING IN TEXT (★★★★☆, "4 out of 5", letter grades, X/5)
 *      - Most reliable - override LLM scores which had 33% error rate
 * P0b. humanReviewScore (manual override from audit queue, 1-100)
 * P0c. originalScore field (aggregator-provided: "4/5 stars", "B+")
 *      - Parsed before LLM to prevent paywall/garbage text from overriding
 * P1.  llmScore.score (HIGH/MEDIUM confidence, with original fullText only)
 *      - Excerpt-only and garbage-recovered reviews are downgraded to low confidence
 * P2.  THUMB override (when LLM is low-conf/excerpt-only AND thumb exists)
 *      - Aggregator editors saw full review, more reliable than incomplete text
 * P3.  llmScore.score (low confidence, needs review, or excerpt-only - fallback when no thumb)
 * P4.  assignedScore (if already set and valid, with known source)
 * P5.  bucket mapping (Rave=90, Positive=82, Mixed=65, Negative=48, Pan=30)
 * P6.  dtliThumb or bwwThumb (Up=80, Flat=60, Down=35) - final fallback
 * P7.  SKIP - do not include in reviews.json
 */

const fs = require('fs');
const path = require('path');
const { getOutletDisplayName } = require('./lib/review-normalization');
const { decodeHtmlEntities, cleanText } = require('./lib/text-cleaning');

// Human review queue — flagged items written to data/audit/needs-human-review.json
const humanReviewQueue = [];

function normalizeThumb(thumb) {
  if (thumb === 'Meh' || thumb === 'Flat') return 'Flat';
  return thumb; // 'Up' or 'Down'
}

function flagForHumanReview(data, reason, detail) {
  humanReviewQueue.push({
    showId: data.showId,
    outletId: data.outletId || data.outlet,
    criticName: data.criticName || null,
    reason,
    detail,
    llmScore: data.llmScore?.score || null,
    llmBucket: data.llmScore?.bucket || null,
    llmConfidence: data.llmScore?.confidence || null,
    dtliThumb: data.dtliThumb || null,
    bwwThumb: data.bwwThumb || null,
    flaggedAt: new Date().toISOString()
  });
}

// Score mappings
const THUMB_TO_SCORE = { 'Up': 80, 'Meh': 60, 'Flat': 60, 'Down': 35 };
const BUCKET_TO_SCORE = { 'Rave': 90, 'Positive': 82, 'Mixed': 65, 'Negative': 48, 'Pan': 30 };
const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 90,
  'B+': 87, 'B': 83, 'B-': 78,
  'C+': 72, 'C': 65, 'C-': 58,
  'D+': 40, 'D': 35, 'D-': 30,
  'F': 20
};

/**
 * EXPLICIT RATING EXTRACTION
 * Extracts ratings directly from review text (stars, grades, X/5, etc.)
 * These are MORE RELIABLE than LLM inference when present
 */

function extractStarRatingFromText(text) {
  if (!text) return null;

  // Match star symbols: ★★★★☆, ★★★☆☆, etc.
  const match = text.match(/★+☆*/);
  if (!match) return null;

  const filled = (match[0].match(/★/g) || []).length;
  const empty = (match[0].match(/☆/g) || []).length;
  const total = filled + empty;

  // Only trust 4-star or 5-star scales
  if (total >= 4 && total <= 5) {
    // When there are no empty stars (☆), we can't determine the scale.
    // ★★★★ could be 4/4 (100%) or 4/5 (80%) — ambiguous without ☆ markers.
    // Exception: ★★★★★ is always 100% regardless of scale.
    // Skip ambiguous cases and let slash/outOf extractors or originalScore handle it.
    if (empty === 0 && filled < 5) return null;

    return {
      type: 'stars',
      raw: match[0],
      score: Math.round((filled / total) * 100)
    };
  }
  return null;
}

function extractOutOfRatingFromText(text) {
  if (!text) return null;

  // "4 out of 5", "3 out of 5", "8 out of 10", etc.
  const match = text.match(/(\d+\.?\d*)\s+out\s+of\s+(5|10|4)\b/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const scale = parseInt(match[2]);

  // Sanity check
  if (value > scale || value < 0) return null;

  return {
    type: `outOf${scale}`,
    raw: match[0],
    score: Math.round((value / scale) * 100)
  };
}

function extractSlashRatingFromText(text) {
  if (!text) return null;

  // Match "3/5" or "4/5" but NOT dates like "2023/4" or "2003/10"
  // Look for patterns NOT preceded by a 4-digit year
  const match = text.match(/(?:^|[^\d])([\d]\.?[\d]?)\s*\/\s*(5|4)(?:[^\d]|$)/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const scale = parseInt(match[2]);

  // Sanity check - value should be <= scale and not be a year fragment
  if (value > scale || value < 0) return null;

  return {
    type: `slash${scale}`,
    raw: `${value}/${scale}`,
    score: Math.round((value / scale) * 100)
  };
}

function extractLetterGradeFromText(text) {
  if (!text) return null;

  // Letter grades need context to avoid false positives
  // Look for: "grade: B+", "Grade: A-", etc.
  // Note: [+\-–—] matches ASCII plus/minus AND en-dash/em-dash (EW uses en-dash for minus)
  // Use (?!\w) instead of \b at end — \b fails after en-dash since it's not a word boundary
  // Only "grade" and "rating" keywords — NOT "score" (too ambiguous in theater: "score a ticket", "score: a joyful combination")
  // "grade" requires colon — "Grade B" without colon is an idiom meaning "mediocre", not a letter grade
  // Removed "gives a X" pattern (captured article "a" as grade "A") and "X grade/rating" pattern (same false positive)
  const patterns = [
    /\b(?:grade:\s*|rating[:\s]+)([A-D][+\-–—]?|F)(?!\w)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Normalize en-dash/em-dash to ASCII minus for lookup
      const grade = match[1].toUpperCase().replace(/[–—]/g, '-');
      const gradeMap = {
        'A+': 97, 'A': 93, 'A-': 90,
        'B+': 87, 'B': 83, 'B-': 78,
        'C+': 72, 'C': 65, 'C-': 58,
        'D+': 40, 'D': 35, 'D-': 30,
        'F': 20
      };
      if (gradeMap[grade]) {
        return {
          type: 'letterGrade',
          raw: grade,
          score: gradeMap[grade]
        };
      }
    }
  }
  return null;
}

/**
 * Extract explicit rating from all text sources in a review
 * Returns { type, raw, score } or null if no explicit rating found
 */
function extractExplicitRating(data) {
  // Combine all text sources
  let allText = [
    data.fullText || '',
    data.dtliExcerpt || '',
    data.bwwExcerpt || '',
    data.showScoreExcerpt || '',
    data.nycTheatreExcerpt || ''
  ].join(' ');

  if (!allText.trim()) return null;

  // Strip NYSR cross-reference lines before extraction — they contain other critics'
  // star ratings (e.g., "[Read Steven Suskin's ★★★★☆ review here.]") that would
  // be incorrectly extracted as this review's rating
  allText = allText
    .replace(/\[Read\s+[^\]]*?★[^\]]*?review[^\]]*?\]/gi, '')
    .replace(/Read\s+\w[^.]*?★+☆*[^.]*?review here\.?/gi, '');

  // Try each extraction method in order of reliability
  // Stars are most reliable (no false positives)
  const starRating = extractStarRatingFromText(allText);
  if (starRating) return starRating;

  // "X out of Y" is also very reliable
  const outOfRating = extractOutOfRatingFromText(allText);
  if (outOfRating) return outOfRating;

  // Slash ratings (3/5) - slightly more prone to false positives
  const slashRating = extractSlashRatingFromText(allText);
  if (slashRating) return slashRating;

  // Letter grades - only with proper context
  const letterGrade = extractLetterGradeFromText(allText);
  if (letterGrade) return letterGrade;

  return null;
}

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const reviewsJsonPath = path.join(__dirname, '../data/reviews.json');

// decodeHtmlEntities imported from ./lib/text-cleaning

/**
 * Detect if text looks like website navigation/junk rather than review content
 */
function isJunkExcerpt(text) {
  if (!text) return true;

  // Patterns that indicate website chrome/navigation
  const junkPatterns = [
    /^Home\s+(Legit|News|Reviews)/i,                    // "Home Legit Reviews..."
    /^\d{1,2}:\d{2}\s*(AM|PM)\s*(PT|ET|CT)/i,          // "5:30pm PT"
    /Plus Icon.*Latest/i,                               // "Plus Icon Aramide Tinubu Latest"
    /See All\s+[A-Z]/i,                                 // "See All Matthew Murphy"
    /\d+ (day|week|month|hour)s? ago/i,                // "1 day ago"
    /Related Stories/i,                                 // "Related Stories"
    /By [A-Z][a-z]+ [A-Z][a-z]+ Plus Icon/i,           // "By Author Name Plus Icon"
    /TV Review.*TV Review/i,                            // Multiple "TV Review" = sidebar
    /Photo:/i,                                          // Photo credits
    /Matthew Murphy\s+[A-Z]/,                           // Photo credit pattern
    /\bdefineSlot\b|\bsetTargeting\b|\bgoogletag\b/i,  // Ad code
    /blogherads/i,                                      // Ad code
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(text)) return true;
  }

  // If first 50 chars contain multiple timestamps/dates, likely junk
  const first50 = text.substring(0, 50);
  const datePatterns = first50.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/gi) || [];
  if (datePatterns.length >= 2) return true;

  return false;
}

/**
 * Clean excerpt text from aggregator sources
 * Fixes: JavaScript/ad code, HTML entities, multi-critic concatenation
 */
function cleanExcerpt(text, aggressive = false) {
  if (!text) return null;

  let cleaned = decodeHtmlEntities(text);

  // Remove JavaScript/ad code patterns
  cleaned = cleaned.replace(/blogherads\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\.defineSlot\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setTargeting\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.addSize\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.exemptFromSleep\(\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setClsOptimization\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/\.setSubAdUnitPath\([^)]+\)[^;]*;?/gi, '');
  cleaned = cleaned.replace(/googletag\.[^;]+;?/gi, '');
  cleaned = cleaned.replace(/\[\s*["']mid-article\d*["'][^\]]*\]/gi, '');
  cleaned = cleaned.replace(/Related Stories\s+[A-Z][^"]*$/gi, '');

  // Remove photo credits mixed into text
  cleaned = cleaned.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\s+(?=Thirty|The|In|When|After|Before|It|This|That|A|An)/g, '');

  // Stop at next critic attribution (BWW roundups concatenate multiple critics)
  const nextCriticMatch = cleaned.match(/\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)?,\s+[A-Z][^:]+:/);
  if (nextCriticMatch && nextCriticMatch.index > 50) {
    cleaned = cleaned.substring(0, nextCriticMatch.index + 1);
  }

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Skip if starts mid-sentence (unless it's a quote)
  if (/^[a-z]/.test(cleaned) && !cleaned.startsWith('"') && cleaned.length < 100) {
    // Try to find the first complete sentence
    const sentenceStart = cleaned.search(/[.!?]\s+[A-Z]/);
    if (sentenceStart > 0 && sentenceStart < cleaned.length - 50) {
      cleaned = cleaned.substring(sentenceStart + 2);
    } else {
      return null;
    }
  }

  // Skip junk excerpts
  if (isJunkExcerpt(cleaned)) {
    return null;
  }

  // Truncate to 350 chars at sentence boundary
  if (cleaned.length > 350) {
    const truncateAt = cleaned.lastIndexOf('.', 350);
    cleaned = truncateAt > 100 ? cleaned.substring(0, truncateAt + 1) : cleaned.substring(0, 347) + '...';
  }

  // Final junk check
  if (/defineSlot|setTargeting|blogherads|Plus Icon/i.test(cleaned)) {
    return null;
  }

  return cleaned.length > 30 ? cleaned : null;
}

/**
 * Extract a good opening excerpt from full review text
 */
function extractExcerptFromFullText(fullText, showTitle) {
  if (!fullText || fullText.length < 200) return null;

  let text = decodeHtmlEntities(fullText);

  // Split into paragraphs/sentences
  const sentences = text.split(/(?<=[.!?])\s+/);

  // Find the first substantive sentence (skip bylines, photo credits)
  let excerpt = '';
  for (const sentence of sentences) {
    // Skip short fragments, bylines, photo credits
    if (sentence.length < 30) continue;
    if (/^By\s+[A-Z]/i.test(sentence)) continue;
    if (/^Photo:/i.test(sentence)) continue;
    if (/^\d{1,2}:\d{2}/i.test(sentence)) continue;

    excerpt += (excerpt ? ' ' : '') + sentence;

    // Stop after 2-3 good sentences or ~300 chars
    if (excerpt.length >= 250 || (excerpt.match(/[.!?]/g) || []).length >= 2) {
      break;
    }
  }

  if (excerpt.length < 50) return null;

  // Truncate if needed
  if (excerpt.length > 350) {
    const truncAt = excerpt.lastIndexOf('.', 350);
    excerpt = truncAt > 100 ? excerpt.substring(0, truncAt + 1) : excerpt.substring(0, 347) + '...';
  }

  return excerpt;
}

/**
 * Select the best available excerpt using smart priority
 * Priority: LLM keyPhrases > showScoreExcerpt > fullText extract > bwwExcerpt > dtliExcerpt
 */
function selectBestExcerpt(data) {
  // 1. Try LLM-extracted key phrases first (already curated quotes!)
  if (data.llmScore?.keyPhrases?.length > 0) {
    // Find a positive or descriptive quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30 && phrase.sentiment !== 'negative') {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          return cleaned;
        }
      }
    }
    // Fall back to any quote
    for (const phrase of data.llmScore.keyPhrases) {
      if (phrase.quote && phrase.quote.length > 30) {
        const cleaned = cleanExcerpt(phrase.quote);
        if (cleaned && !isJunkExcerpt(cleaned)) {
          return cleaned;
        }
      }
    }
  }

  // 2. Try showScoreExcerpt (usually human-curated, cleaner)
  if (data.showScoreExcerpt) {
    const cleaned = cleanExcerpt(data.showScoreExcerpt);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 3. Try extracting from fullText (skip truncated/garbage scrapes)
  if (data.fullText && data.fullText.length > 300 && data.textStatus !== 'truncated') {
    const extracted = extractExcerptFromFullText(data.fullText, data.showId);
    if (extracted && extracted.length > 50) {
      return extracted;
    }
  }

  // 4. Try bwwExcerpt (usually cleaner than DTLI)
  if (data.bwwExcerpt) {
    const cleaned = cleanExcerpt(data.bwwExcerpt);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 5. Try nycTheatreExcerpt (similar quality to dtli/bww)
  if (data.nycTheatreExcerpt) {
    const cleaned = cleanExcerpt(data.nycTheatreExcerpt);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 6. Last resort: dtliExcerpt with aggressive cleaning
  if (data.dtliExcerpt) {
    const cleaned = cleanExcerpt(data.dtliExcerpt, true);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  // 7. Try existing pullQuote if nothing else works
  if (data.pullQuote) {
    const cleaned = cleanExcerpt(data.pullQuote);
    if (cleaned && cleaned.length > 40) {
      return cleaned;
    }
  }

  return null;
}

// Stats tracking
const stats = {
  totalFiles: 0,
  totalReviews: 0,
  skippedNoScore: 0,
  skippedDuplicate: 0,
  scoreSources: {
    'explicit-stars': 0,
    'explicit-outOf': 0,
    'explicit-slash': 0,
    'explicit-letterGrade': 0,
    'human-review': 0,
    'originalScore-priority0': 0,
    llmScore: 0,
    'thumb-override-llm': 0,  // Thumb used instead of low-conf/needs-review LLM
    'llmScore-lowconf': 0,
    'llmScore-review': 0,
    assignedScore: 0,
    originalScore: 0,
    bucket: 0,
    thumb: 0
  },
  explicitOverrideLlm: 0,  // Count how many times explicit rating overrode LLM
  thumbOverrideLlm: 0,     // Count how many times thumb overrode low-conf LLM
  unscoredWithText: [],     // Reviews with text but no LLM score (should be scored!)
  byShow: {}
};

const skippedReviews = [];

function parseStarRating(rating) {
  if (!rating) return null;
  const r = rating.toString();

  const starMatch = r.match(/^(\d(?:\.\d)?)\s*(?:\/\s*(\d)|out\s+of\s+(\d)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = parseInt(starMatch[2] || starMatch[3] || '5');
    return Math.round((stars / maxStars) * 100);
  }

  const starSymbols = (r.match(/★/g) || []).length;
  const emptyStars = (r.match(/☆/g) || []).length;
  if (starSymbols > 0) {
    const total = starSymbols + emptyStars || 5;
    return Math.round((starSymbols / total) * 100);
  }

  return null;
}

function parseLetterGrade(rating) {
  if (!rating) return null;
  const r = rating.toString().trim().toUpperCase();

  const letterMatch = r.match(/^([A-D][+-]?|F)$/i);
  if (letterMatch) {
    return LETTER_TO_SCORE[letterMatch[1].toUpperCase()] || null;
  }

  return null;
}

function parseOriginalScore(rating) {
  if (!rating) return null;

  const starScore = parseStarRating(rating);
  if (starScore !== null) return starScore;

  const letterScore = parseLetterGrade(rating);
  if (letterScore !== null) return letterScore;

  const numMatch = rating.toString().match(/^(\d+)\s*(?:\/\s*100)?$/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    if (num >= 0 && num <= 100) return num;
  }

  return null;
}

function getBestScore(data) {
  // Skip if explicitly marked as TO_BE_CALCULATED
  if (data.scoreStatus === 'TO_BE_CALCULATED') {
    return null;
  }

  // Priority 0: EXPLICIT RATINGS IN TEXT (most reliable!)
  // Star ratings, letter grades, "X out of Y" directly stated in the review
  // These override LLM scores which have ~33% error rate on explicit ratings
  const explicitRating = extractExplicitRating(data);
  if (explicitRating) {
    // Track if this overrides an LLM score
    if (data.llmScore && data.llmScore.score) {
      const diff = Math.abs(explicitRating.score - data.llmScore.score);
      if (diff > 15) {
        stats.explicitOverrideLlm++;
      }
    }

    // Map rating type to source
    let sourceType = 'explicit-stars';
    if (explicitRating.type.startsWith('outOf')) sourceType = 'explicit-outOf';
    else if (explicitRating.type.startsWith('slash')) sourceType = 'explicit-slash';
    else if (explicitRating.type === 'letterGrade') sourceType = 'explicit-letterGrade';

    return {
      score: explicitRating.score,
      source: sourceType,
      explicitRaw: explicitRating.raw
    };
  }

  // Priority 0.5: Human-reviewed score (manual override from audit queue)
  // These are set after reviewing flagged reviews where LLM and thumbs disagree
  if (data.humanReviewScore && data.humanReviewScore >= 1 && data.humanReviewScore <= 100) {
    return { score: data.humanReviewScore, source: 'human-review' };
  }

  // Priority 0b: Parse originalScore field BEFORE LLM
  // Aggregator-provided ratings like "4/5 stars", "B+", "★★★★☆" are more reliable
  // than LLM scores, which can be confused by garbage/paywall text
  if (data.originalScore) {
    const parsed = parseOriginalScore(data.originalScore);
    if (parsed !== null) {
      return { score: parsed, source: 'originalScore-priority0' };
    }
  }

  // Priority 1: LLM score (HIGH/MEDIUM confidence only)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;

    // Downgrade confidence when scoring from excerpt-only text
    // Audit showed ~50% error rate on excerpt-only high/medium confidence scores
    // Also downgrade when fullText was recovered from garbage — the LLM scored the excerpt, not the recovered text
    const hasOriginalFullText = data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom;
    const effectiveConfidence = (!hasOriginalFullText && confidence !== 'low') ? 'low' : confidence;

    // High/medium confidence: use directly
    if (effectiveConfidence !== 'low' && !needsReview) {
      // Flag if BOTH thumbs agree with each other but disagree with LLM direction
      const llmThumb = data.llmScore.score >= 70 ? 'Up' : data.llmScore.score >= 55 ? 'Flat' : 'Down';
      const dtli = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
      const bww = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
      if (dtli && bww && dtli === bww && dtli !== llmThumb) {
        flagForHumanReview(data, 'both-thumbs-disagree-with-llm',
          `LLM=${data.llmScore.score} (${llmThumb}), both thumbs=${data.dtliThumb}`);
      }
      return { score: data.llmScore.score, source: 'llmScore' };
    }
  }

  // P2: Thumb override of low-confidence/needs-review/excerpt-only LLM scores
  const hasLowConfLlm = data.llmScore?.score &&
    (data.llmScore.confidence === 'low' || data.ensembleData?.needsReview ||
     !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom));

  if (hasLowConfLlm) {
    const dtliThumbNorm = data.dtliThumb ? normalizeThumb(data.dtliThumb) : null;
    const bwwThumbNorm = data.bwwThumb ? normalizeThumb(data.bwwThumb) : null;
    const dtliScore = data.dtliThumb ? THUMB_TO_SCORE[data.dtliThumb] : null;
    const bwwScore = data.bwwThumb ? THUMB_TO_SCORE[data.bwwThumb] : null;
    const llmScore = data.llmScore.score;
    const llmBucket = scoreToBucket(llmScore);

    // Helper: map thumb/bucket to broad direction for comparison
    // Thumbs only have 3 levels (Up/Flat/Down) but scores have 5 buckets (Rave/Positive/Mixed/Negative/Pan).
    // Up covers both Positive AND Rave; Down covers both Negative AND Pan.
    // Comparing directions prevents false overrides (e.g., Up vs Rave = same direction, not a disagreement).
    const thumbDirection = (thumb) => {
      if (thumb === 'Up') return 'positive';
      if (thumb === 'Down') return 'negative';
      return 'neutral'; // Flat/Meh
    };
    const bucketDirection = (bucket) => {
      if (bucket === 'Rave' || bucket === 'Positive') return 'positive';
      if (bucket === 'Negative' || bucket === 'Pan') return 'negative';
      return 'neutral'; // Mixed
    };

    // Rule 3: Meh/Flat thumbs (value=60) → DO NOT override, they were wrong 83% of the time
    const dtliIsMeh = dtliThumbNorm === 'Flat';
    const bwwIsMeh = bwwThumbNorm === 'Flat';

    if ((dtliIsMeh && !bwwScore) || (bwwIsMeh && !dtliScore) || (dtliIsMeh && bwwIsMeh)) {
      // Both are Meh or only Meh available — don't override
      data.mehThumbIgnored = true;
      // Fall through to LLM fallback (Priority 3)
    } else {
      // Rule 1: Both thumbs agree AND disagree with LLM direction → override (high signal)
      // Uses direction comparison (positive/negative/neutral) not exact bucket,
      // because thumbs can't distinguish Rave from Positive (both map to Up)
      // or Pan from Negative (both map to Down).
      if (dtliThumbNorm && bwwThumbNorm && dtliThumbNorm === bwwThumbNorm && !dtliIsMeh) {
        if (thumbDirection(dtliThumbNorm) !== bucketDirection(llmBucket)) {
          const thumbScore = dtliScore; // Both agree, use dtli
          // Auto-resolved: thumb score wins. No human review needed.
          stats.thumbOverrideLlm = (stats.thumbOverrideLlm || 0) + 1;
          return { score: thumbScore, source: 'thumb-override-llm' };
        }
      }

      // Rule 2: Single thumb, delta >25, AND LLM confidence is low/excerpt-only → override
      const singleThumb = dtliScore && !dtliIsMeh ? dtliScore : (bwwScore && !bwwIsMeh ? bwwScore : null);
      if (singleThumb) {
        const delta = Math.abs(singleThumb - llmScore);
        const isExcerptBased = data.llmMetadata?.textSource?.type === 'excerpt' ||
          data.llmMetadata?.textSource?.status === 'excerpt-only';
        if (delta > 25 && (data.llmScore.confidence === 'low' || isExcerptBased)) {
          // Auto-resolved: single thumb wins. No human review needed.
          stats.thumbOverrideLlm = (stats.thumbOverrideLlm || 0) + 1;
          return { score: singleThumb, source: 'thumb-override-llm' };
        }
      }
    }
  }

  // P3: LLM score fallback (low confidence, needs review, or excerpt-only - when no thumb available)
  if (data.llmScore && data.llmScore.score) {
    const confidence = data.llmScore.confidence;
    const needsReview = data.ensembleData?.needsReview;
    const isExcerptOnly = !(data.fullText && data.fullText.trim().length > 100 && !data.fullTextRecoveredFrom);

    if (confidence === 'low' || isExcerptOnly) {
      return { score: data.llmScore.score, source: 'llmScore-lowconf' };
    }
    if (needsReview) {
      return { score: data.llmScore.score, source: 'llmScore-review' };
    }
  }

  // P4: Existing assignedScore (if valid AND has a known source)
  if (data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100) {
    // Check if this has a legitimate source
    const validSources = ['llmScore', 'originalScore', 'bucket', 'thumb',
                          'extracted-grade', 'extracted-rating', 'extracted-unicode-stars',
                          'extracted-thumbs', 'extracted-strong-positive', 'extracted-strong-negative',
                          'sentiment-strong-positive', 'sentiment-positive', 'sentiment-mixed-positive',
                          'sentiment-mixed', 'sentiment-mixed-negative', 'sentiment-negative',
                          'sentiment-strong-negative', 'manual', 'manual-excerpt'];

    if (data.scoreSource && validSources.some(s => data.scoreSource.includes(s))) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }

    // Also accept if there's evidence of how it was scored (thumb data, etc.)
    if (data.dtliThumb || data.bwwThumb || data.originalScore || data.bucket) {
      return { score: data.assignedScore, source: 'assignedScore' };
    }
  }

  // P5: Bucket mapping
  if (data.bucket && BUCKET_TO_SCORE[data.bucket]) {
    return { score: BUCKET_TO_SCORE[data.bucket], source: 'bucket' };
  }

  // P6: Thumb mappings (dtli first, then bww)
  if (data.dtliThumb && THUMB_TO_SCORE[data.dtliThumb]) {
    return { score: THUMB_TO_SCORE[data.dtliThumb], source: 'thumb' };
  }
  if (data.bwwThumb && THUMB_TO_SCORE[data.bwwThumb]) {
    return { score: THUMB_TO_SCORE[data.bwwThumb], source: 'thumb' };
  }
  if (data.thumb && THUMB_TO_SCORE[data.thumb]) {
    return { score: THUMB_TO_SCORE[data.thumb], source: 'thumb' };
  }

  // NO DEFAULT - return null to skip this review
  return null;
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 40) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

function normalizeOutletId(outlet) {
  if (!outlet) return 'unknown';
  return outlet.toString().toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20);
}

// Main execution
console.log('=== REBUILDING ALL REVIEWS ===\n');
console.log('NOTE: Reviews without valid scores are EXCLUDED (no default of 50)\n');

// Get all show directories
const showDirs = fs.readdirSync(reviewTextsDir)
  .filter(f => {
    const fullPath = path.join(reviewTextsDir, f);
    // Skip symlinks to avoid processing the same directory twice
    if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
    return fs.statSync(fullPath).isDirectory();
  });

console.log(`Found ${showDirs.length} show directories\n`);

const allReviews = [];

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  stats.byShow[showId] = { files: files.length, reviews: 0, skipped: 0 };
  stats.totalFiles += files.length;

  // Track seen outlet+critic combinations to avoid duplicates
  const seenKeys = new Set();

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Recover review text from garbageFullText when fullText is missing
      // Some reviews were flagged as garbage only due to trailing junk (newsletters, copyright)
      // but contain valid review text that can be cleaned and promoted
      // NEVER recover from 404/error pages — they contain content from other reviews
      // (e.g., NYSR 404 pages include star ratings for unrelated reviews)
      const isErrorPage = data.garbageReason &&
        (/^Error\/404/i.test(data.garbageReason) || /page not found/i.test(data.garbageReason));
      if (!data.fullText && data.garbageFullText && data.garbageFullText.length > 200 && !isErrorPage) {
        const cleaned = cleanText(data.garbageFullText);
        if (cleaned && cleaned.length > 200) {
          data.fullText = cleaned;
          data.fullTextRecoveredFrom = 'garbageFullText';
          stats.recoveredFromGarbage = (stats.recoveredFromGarbage || 0) + 1;
        }
      }

      // Skip wrong-production reviews (e.g., off-Broadway reviews filed under Broadway show)
      if (data.wrongProduction === true) {
        stats.skippedWrongProduction = (stats.skippedWrongProduction || 0) + 1;
        return;
      }

      // Skip wrong-show reviews (review content is for a different show)
      if (data.wrongShow === true) {
        stats.skippedWrongShow = (stats.skippedWrongShow || 0) + 1;
        return;
      }

      // Skip misattributed reviews (LLM-hallucinated critic/outlet combos)
      if (data.wrongAttribution === true) {
        stats.skippedWrongAttribution = (stats.skippedWrongAttribution || 0) + 1;
        return;
      }

      // Create deduplication key
      const outletKey = normalizeOutletId(data.outlet || data.outletId);
      const criticKey = normalizeOutletId(data.criticName || '');
      const dedupKey = `${outletKey}|${criticKey}`;

      // Skip exact duplicates (keep first occurrence)
      if (seenKeys.has(dedupKey)) {
        stats.skippedDuplicate++;
        return;
      }

      // First-name prefix dedup: "jesse" at "nytimes" matches "jessegreen" at "nytimes"
      // This catches files like nytimes--jesse.json vs nytimes--jesse-green.json
      let prefixDuplicate = false;
      for (const existingKey of seenKeys) {
        const [existingOutlet, existingCritic] = existingKey.split('|');
        if (existingOutlet !== outletKey) continue;
        if (criticKey.length >= 3 && existingCritic.startsWith(criticKey)) {
          // Incoming is shorter name (e.g., "jesse"), existing is full name — skip incoming
          prefixDuplicate = true;
          break;
        }
        if (existingCritic.length >= 3 && criticKey.startsWith(existingCritic)) {
          // Incoming is full name (e.g., "jessegreen"), existing is shorter — keep incoming, but don't remove existing
          // The existing shorter-name entry is already in the output; this is a rare edge case.
          // For now, skip the incoming to avoid duplicates. The file-level dedup in gather-reviews.js
          // is the primary defense; this is a safety net.
          prefixDuplicate = true;
          break;
        }
      }
      if (prefixDuplicate) {
        stats.skippedDuplicate++;
        return;
      }

      seenKeys.add(dedupKey);

      // CHECK: Flag reviews that SHOULD have LLM scores but don't
      // These have scorable text but were never run through LLM scoring
      const scorableText = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || '';
      const hasScorableText = scorableText.length >= 100;
      const hasLlmScore = data.llmScore && data.llmScore.score;

      if (hasScorableText && !hasLlmScore) {
        stats.unscoredWithText.push({
          path: showId + '/' + file,
          textLength: scorableText.length,
          hasThumb: !!(data.dtliThumb || data.bwwThumb)
        });
      }

      // Get best score - returns null if no valid score
      const scoreResult = getBestScore(data);

      if (scoreResult === null) {
        // Skip this review - no valid score
        stats.skippedNoScore++;
        stats.byShow[showId].skipped++;
        skippedReviews.push({
          showId,
          file,
          outlet: data.outlet,
          critic: data.criticName
        });
        return;
      }

      const { score, source } = scoreResult;
      stats.scoreSources[source]++;

      // Build review object
      const review = {
        showId: data.showId || showId,
        outletId: data.outletId || outletKey.toUpperCase(),
        outlet: getOutletDisplayName(data.outletId) || data.outlet || data.outletId || 'Unknown',
        assignedScore: score,
        scoreSource: source,
        bucket: scoreToBucket(score),
        thumb: scoreToThumb(score),
        criticName: data.criticName || null,
        url: data.url || null,
        publishDate: data.publishDate || null,
        originalRating: data.originalScore || null,
        pullQuote: selectBestExcerpt(data),
        dtliThumb: data.dtliThumb || null,
        bwwThumb: data.bwwThumb || null,
        contentTier: data.contentTier || 'none'
      };

      // Add designation if present
      if (data.designation) {
        review.designation = data.designation;
      }

      allReviews.push(review);
      stats.byShow[showId].reviews++;
      stats.totalReviews++;

    } catch (e) {
      console.error(`  Error processing ${file}: ${e.message}`);
    }
  });
});

// Sort reviews by showId, then outlet
allReviews.sort((a, b) => {
  if (a.showId !== b.showId) return a.showId.localeCompare(b.showId);
  return (a.outlet || '').localeCompare(b.outlet || '');
});

// ========================================
// 3B: SCORE-DRIFT GUARD
// ========================================
// Compare new scores against current reviews.json to detect silent cascading changes.
const DRIFT_THRESHOLD = 20; // Max reviews that can shift >10 points before warning
const DRIFT_POINT_THRESHOLD = 10; // Score difference to count as "drift"

let driftReport = null;
if (fs.existsSync(reviewsJsonPath)) {
  try {
    const currentData = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
    const currentReviews = currentData.reviews || [];

    // Build lookup: showId+outlet+critic → score
    const currentScoreMap = new Map();
    for (const r of currentReviews) {
      const key = `${r.showId}|${(r.outlet || '').toLowerCase()}|${(r.criticName || '').toLowerCase()}`;
      currentScoreMap.set(key, r.assignedScore);
    }

    // Find drifted reviews
    const driftedReviews = [];
    for (const r of allReviews) {
      const key = `${r.showId}|${(r.outlet || '').toLowerCase()}|${(r.criticName || '').toLowerCase()}`;
      const oldScore = currentScoreMap.get(key);
      if (oldScore !== undefined) {
        const delta = Math.abs(r.assignedScore - oldScore);
        if (delta > DRIFT_POINT_THRESHOLD) {
          driftedReviews.push({
            showId: r.showId,
            outlet: r.outlet,
            critic: r.criticName,
            oldScore,
            newScore: r.assignedScore,
            delta
          });
        }
      }
    }

    if (driftedReviews.length > 0) {
      driftReport = {
        timestamp: new Date().toISOString(),
        totalDrifted: driftedReviews.length,
        threshold: DRIFT_THRESHOLD,
        reviews: driftedReviews.sort((a, b) => b.delta - a.delta)
      };

      // Write drift report
      const auditDir = path.join(__dirname, '../data/audit');
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(auditDir, 'rebuild-score-drift.json'),
        JSON.stringify(driftReport, null, 2) + '\n'
      );

      console.log(`\n⚠️  SCORE DRIFT: ${driftedReviews.length} reviews shifted by >${DRIFT_POINT_THRESHOLD} points`);
      driftedReviews.slice(0, 10).forEach(d => {
        console.log(`  ${d.showId}: ${d.outlet} (${d.critic}) ${d.oldScore}→${d.newScore} (Δ${d.delta})`);
      });
      if (driftedReviews.length > 10) {
        console.log(`  ...and ${driftedReviews.length - 10} more`);
      }

      // In CI: fail if drift exceeds threshold (unless ALLOW_DRIFT=true)
      if (driftedReviews.length > DRIFT_THRESHOLD && process.env.CI && !process.env.ALLOW_DRIFT) {
        console.error(`\n❌ DRIFT GUARD: ${driftedReviews.length} reviews drifted (threshold: ${DRIFT_THRESHOLD})`);
        console.error('Set ALLOW_DRIFT=true to override, or review data/audit/rebuild-score-drift.json');
        process.exit(1);
      }
    }
  } catch (e) {
    // Can't read current file, skip drift check (first build)
  }
}

// ========================================
// 3C: CONSISTENCY AUDIT
// ========================================
// Detect rating conversion bugs, designation mismatches, and score clustering.
const consistencyIssues = [];

for (const r of allReviews) {
  // Check 1: Original rating vs assigned score mismatch
  if (r.originalRating && typeof r.originalRating === 'string') {
    const parsed = parseOriginalScore(r.originalRating);
    if (parsed !== null && Math.abs(r.assignedScore - parsed) > 20) {
      consistencyIssues.push({
        type: 'rating-score-mismatch',
        severity: 'high',
        showId: r.showId,
        outlet: r.outletId,
        critic: r.criticName,
        detail: `originalRating "${r.originalRating}" (=${parsed}) vs score ${r.assignedScore} (source: ${r.scoreSource})`
      });
    }
  }

  // Check 2: Positive designation with very low score
  const positiveDesignations = ['Critics_Pick', 'Critics_Choice', 'Must_See'];
  if (positiveDesignations.includes(r.designation) && r.assignedScore < 55) {
    consistencyIssues.push({
      type: 'designation-score-mismatch',
      severity: 'medium',
      showId: r.showId,
      outlet: r.outletId,
      critic: r.criticName,
      detail: `${r.designation} but score=${r.assignedScore} (source: ${r.scoreSource})`
    });
  }
}

// Check 3: Score clustering per show (many identical LLM scores)
const showGroups = {};
for (const r of allReviews) {
  if (!showGroups[r.showId]) showGroups[r.showId] = [];
  showGroups[r.showId].push(r);
}
for (const [showId, revs] of Object.entries(showGroups)) {
  if (revs.length < 6) continue;
  const scoreCounts = {};
  for (const r of revs) {
    scoreCounts[r.assignedScore] = (scoreCounts[r.assignedScore] || 0) + 1;
  }
  for (const [score, count] of Object.entries(scoreCounts)) {
    const pct = (count / revs.length) * 100;
    if (count >= 5 && pct >= 35) {
      consistencyIssues.push({
        type: 'score-clustering',
        severity: 'low',
        showId,
        detail: `${count}/${revs.length} reviews (${pct.toFixed(0)}%) scored exactly ${score}`
      });
    }
  }
}

if (consistencyIssues.length > 0) {
  const auditDir = path.join(__dirname, '../data/audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'rebuild-consistency.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), issues: consistencyIssues }, null, 2) + '\n'
  );

  const byType = {};
  consistencyIssues.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });

  console.log(`\n⚠️  CONSISTENCY AUDIT: ${consistencyIssues.length} issues detected`);
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }
  const highSeverity = consistencyIssues.filter(i => i.severity === 'high');
  if (highSeverity.length > 0) {
    console.log('\n  HIGH SEVERITY issues:');
    for (const i of highSeverity.slice(0, 10)) {
      console.log(`    ${i.showId} / ${i.outlet}: ${i.detail}`);
    }
  }
  console.log(`  Full report: data/audit/rebuild-consistency.json`);
}

// Build output
const output = {
  _meta: {
    description: "Critic reviews - raw input data",
    lastUpdated: new Date().toISOString().split('T')[0],
    notes: "Rebuilt from review-texts. Reviews without valid scores are EXCLUDED.",
    stats: {
      totalReviews: stats.totalReviews,
      skippedNoScore: stats.skippedNoScore,
      skippedDuplicate: stats.skippedDuplicate,
      skippedWrongProduction: stats.skippedWrongProduction || 0,
      recoveredFromGarbage: stats.recoveredFromGarbage || 0,
      scoreSources: stats.scoreSources
    }
  },
  reviews: allReviews
};

// Write output
fs.writeFileSync(reviewsJsonPath, JSON.stringify(output, null, 2));

// Print summary
console.log('\n=== SUMMARY ===\n');
console.log(`Total files processed: ${stats.totalFiles}`);
console.log(`Total reviews INCLUDED: ${stats.totalReviews}`);
console.log(`  Skipped (no valid score): ${stats.skippedNoScore}`);
console.log(`  Skipped (duplicate): ${stats.skippedDuplicate}`);
console.log(`  Skipped (wrong production): ${stats.skippedWrongProduction || 0}`);
if (stats.recoveredFromGarbage > 0) {
  console.log(`  Recovered from garbageFullText: ${stats.recoveredFromGarbage}`);
}

// Explicit rating summary
const explicitCount = (stats.scoreSources['explicit-stars'] || 0) +
                      (stats.scoreSources['explicit-outOf'] || 0) +
                      (stats.scoreSources['explicit-slash'] || 0) +
                      (stats.scoreSources['explicit-letterGrade'] || 0);
if (explicitCount > 0) {
  console.log(`\nExplicit ratings extracted from text: ${explicitCount}`);
  console.log(`  Overrode conflicting LLM scores: ${stats.explicitOverrideLlm}`);
}

// Thumb override summary
if (stats.thumbOverrideLlm > 0) {
  console.log(`\nThumb overrides of low-conf/needs-review LLM: ${stats.thumbOverrideLlm}`);
  console.log(`  (Aggregator editors saw full review, more reliable than incomplete text)`);
}

console.log('\nScore sources:');
Object.entries(stats.scoreSources).forEach(([source, count]) => {
  if (count > 0) {
    console.log(`  ${source}: ${count} (${(count/stats.totalReviews*100).toFixed(1)}%)`);
  }
});

// Show per-show counts
console.log('\n=== REVIEWS PER SHOW ===\n');
const showCounts = Object.entries(stats.byShow)
  .map(([show, data]) => ({ show, ...data }))
  .sort((a, b) => b.reviews - a.reviews);

showCounts.forEach(({ show, files, reviews, skipped }) => {
  const skipNote = skipped > 0 ? ` (${skipped} skipped - no score)` : '';
  console.log(`  ${show}: ${reviews} reviews${skipNote}`);
});

if (skippedReviews.length > 0) {
  console.log(`\n=== SKIPPED REVIEWS (${skippedReviews.length}) ===`);
  console.log('These need scoring before they can be included:');

  // Group by show
  const byShow = {};
  skippedReviews.forEach(r => {
    byShow[r.showId] = byShow[r.showId] || [];
    byShow[r.showId].push(r);
  });

  Object.entries(byShow).forEach(([show, reviews]) => {
    console.log(`\n  ${show}:`);
    reviews.slice(0, 5).forEach(r => {
      console.log(`    - ${r.outlet} (${r.critic || 'unknown'})`);
    });
    if (reviews.length > 5) {
      console.log(`    ... and ${reviews.length - 5} more`);
    }
  });
}

// WARNING: Reviews that should have LLM scores but don't
if (stats.unscoredWithText.length > 0) {
  console.log(`\n⚠️  WARNING: ${stats.unscoredWithText.length} REVIEWS NEED LLM SCORING`);
  console.log('These have scorable text (100+ chars) but no LLM score.');
  console.log('Run: gh workflow run "LLM Ensemble Score Reviews" to score them.\n');

  // Group by show
  const byShow = {};
  stats.unscoredWithText.forEach(r => {
    const show = r.path.split('/')[0];
    byShow[show] = (byShow[show] || 0) + 1;
  });

  console.log('By show:');
  Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([show, count]) => {
    console.log(`  ${show}: ${count}`);
  });
  if (Object.keys(byShow).length > 10) {
    console.log(`  ... and ${Object.keys(byShow).length - 10} more shows`);
  }
}

// Write human review queue (always write, even if empty, to clear stale data)
{
  const auditDir = path.join(__dirname, '../data/audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const auditPath = path.join(auditDir, 'needs-human-review.json');
  const auditOutput = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalFlagged: humanReviewQueue.length,
      reasons: {}
    },
    reviews: humanReviewQueue
  };

  // Count by reason
  humanReviewQueue.forEach(r => {
    auditOutput._meta.reasons[r.reason] = (auditOutput._meta.reasons[r.reason] || 0) + 1;
  });

  fs.writeFileSync(auditPath, JSON.stringify(auditOutput, null, 2) + '\n');
  if (humanReviewQueue.length > 0) {
    console.log(`\nHUMAN REVIEW QUEUE: ${humanReviewQueue.length} reviews flagged`);
    Object.entries(auditOutput._meta.reasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
    console.log(`  Written to: ${auditPath}`);
  } else {
    console.log(`\nHUMAN REVIEW QUEUE: 0 reviews flagged (all clear)`);
  }
}

console.log('\n=== DONE ===');
console.log(`\nReviews saved to: ${reviewsJsonPath}`);
