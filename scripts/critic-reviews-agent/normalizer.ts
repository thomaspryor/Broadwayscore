/**
 * Rating Normalizer
 *
 * Converts various rating formats to a consistent 0-100 scale.
 * This is the core logic for ensuring consistency across all reviews.
 *
 * IMPORTANT: All normalization rules are deterministic and documented.
 * Running the same input twice will always produce the same output.
 */

import {
  LETTER_GRADE_MAP,
  TEXT_BUCKET_MAP,
  THUMB_MAP,
  scoreToBucket,
  scoreToThumb,
  findOutletConfig,
  DESIGNATION_PATTERNS,
} from './config';
import { RawReview, NormalizedReview, OutletConfig } from './types';

// ===========================================
// STAR RATING CONVERSION
// ===========================================

/**
 * Convert star rating to 0-100 scale
 * Examples:
 *   - 4/5 stars → 80
 *   - 3.5/5 stars → 70
 *   - 3/4 stars → 75
 */
export function normalizeStarRating(stars: number, maxStars: number): number {
  if (maxStars <= 0) throw new Error('Invalid max stars');
  if (stars < 0) stars = 0;
  if (stars > maxStars) stars = maxStars;

  return Math.round((stars / maxStars) * 100);
}

/**
 * Parse star rating from string
 * Handles: "4/5", "4 out of 5", "4 stars", "★★★★", "3.5/5"
 */
export function parseStarRating(ratingStr: string): { stars: number; maxStars: number } | null {
  const normalized = ratingStr.trim().toLowerCase();

  // Handle "X/Y" format (e.g., "4/5", "3.5/5")
  const slashMatch = normalized.match(/^(\d+\.?\d*)\s*\/\s*(\d+)/);
  if (slashMatch) {
    return {
      stars: parseFloat(slashMatch[1]),
      maxStars: parseInt(slashMatch[2], 10),
    };
  }

  // Handle "X out of Y" format
  const outOfMatch = normalized.match(/^(\d+\.?\d*)\s*(?:out\s*of|of)\s*(\d+)/);
  if (outOfMatch) {
    return {
      stars: parseFloat(outOfMatch[1]),
      maxStars: parseInt(outOfMatch[2], 10),
    };
  }

  // Handle "X stars" format (assume out of 5)
  const starsMatch = normalized.match(/^(\d+\.?\d*)\s*stars?/);
  if (starsMatch) {
    return {
      stars: parseFloat(starsMatch[1]),
      maxStars: 5,
    };
  }

  // Handle star symbols (★ or *)
  const starSymbols = (normalized.match(/[★⭐\*]/g) || []).length;
  if (starSymbols > 0) {
    // Check for half stars
    const halfStars = (normalized.match(/[½⯨]/g) || []).length;
    // Assume max 5 unless more symbols present
    const maxStars = Math.max(5, starSymbols + halfStars);
    return {
      stars: starSymbols + (halfStars * 0.5),
      maxStars,
    };
  }

  return null;
}

// ===========================================
// LETTER GRADE CONVERSION
// ===========================================

/**
 * Normalize letter grade to 0-100
 */
export function normalizeLetterGrade(grade: string): number | null {
  const normalized = grade.trim().toUpperCase();
  return LETTER_GRADE_MAP[normalized] ?? null;
}

/**
 * Parse letter grade from string
 * Handles: "A+", "B-", "A minus", "Grade: B+"
 */
export function parseLetterGrade(ratingStr: string): string | null {
  const normalized = ratingStr.trim().toUpperCase();

  // Direct match
  if (LETTER_GRADE_MAP[normalized] !== undefined) {
    return normalized;
  }

  // Handle "A minus", "B plus" format
  const wordMatch = normalized.match(/^([A-F])\s*(PLUS|MINUS)?$/);
  if (wordMatch) {
    const letter = wordMatch[1];
    const modifier = wordMatch[2];
    if (modifier === 'PLUS') return `${letter}+`;
    if (modifier === 'MINUS') return `${letter}-`;
    return letter;
  }

  // Handle "Grade: X" format
  const gradeMatch = normalized.match(/GRADE\s*:?\s*([A-F][+-]?)/);
  if (gradeMatch) {
    return gradeMatch[1];
  }

  return null;
}

// ===========================================
// TEXT BUCKET CONVERSION
// ===========================================

/**
 * Normalize text bucket description to 0-100
 */
export function normalizeTextBucket(bucket: string): number | null {
  const normalized = bucket.trim().toLowerCase();
  return TEXT_BUCKET_MAP[normalized] ?? null;
}

/**
 * Try to infer sentiment bucket from review text/excerpt
 * Returns a score based on sentiment keywords
 */
export function inferSentimentFromText(text: string): number | null {
  if (!text || text.length < 10) return null;

  const normalized = text.toLowerCase();

  // Count positive and negative indicators
  const positiveWords = [
    'brilliant', 'masterpiece', 'stunning', 'extraordinary', 'magnificent',
    'wonderful', 'excellent', 'superb', 'terrific', 'delightful', 'enchanting',
    'captivating', 'riveting', 'electrifying', 'triumphant', 'soaring',
    'dazzling', 'star-making', 'must-see', 'unmissable', 'essential',
  ];
  const strongPositiveWords = ['masterpiece', 'extraordinary', 'triumphant', 'must-see'];

  const negativeWords = [
    'disappointing', 'tedious', 'boring', 'dull', 'flat', 'lifeless',
    'uninspired', 'mediocre', 'weak', 'forgettable', 'tired', 'stale',
    'misguided', 'problematic', 'awkward', 'clunky', 'overlong',
  ];
  const strongNegativeWords = ['terrible', 'awful', 'disaster', 'avoid', 'skip'];

  const mixedWords = [
    'uneven', 'inconsistent', 'mixed', 'some', 'however', 'but', 'despite',
    'although', 'while', 'moments', 'occasionally',
  ];

  let positiveCount = 0;
  let negativeCount = 0;
  let mixedCount = 0;

  for (const word of positiveWords) {
    if (normalized.includes(word)) positiveCount++;
  }
  for (const word of strongPositiveWords) {
    if (normalized.includes(word)) positiveCount += 2;
  }
  for (const word of negativeWords) {
    if (normalized.includes(word)) negativeCount++;
  }
  for (const word of strongNegativeWords) {
    if (normalized.includes(word)) negativeCount += 2;
  }
  for (const word of mixedWords) {
    if (normalized.includes(word)) mixedCount++;
  }

  // Calculate sentiment score
  const total = positiveCount + negativeCount + mixedCount;
  if (total === 0) return null;

  const positiveRatio = positiveCount / total;
  const negativeRatio = negativeCount / total;

  // Base score on ratios
  if (positiveRatio > 0.6 && negativeRatio < 0.2) {
    return positiveCount > 3 ? 88 : 78;
  }
  if (negativeRatio > 0.6 && positiveRatio < 0.2) {
    return negativeCount > 3 ? 35 : 45;
  }
  if (mixedCount > positiveCount && mixedCount > negativeCount) {
    return 60;
  }

  // Default mixed score weighted by sentiment
  return Math.round(50 + (positiveRatio - negativeRatio) * 30);
}

// ===========================================
// THUMB RATING CONVERSION
// ===========================================

/**
 * Normalize thumb rating to 0-100
 */
export function normalizeThumbRating(thumb: string): number | null {
  const normalized = thumb.trim().toLowerCase();
  return THUMB_MAP[normalized] ?? null;
}

// ===========================================
// NUMERIC RATING CONVERSION
// ===========================================

/**
 * Normalize numeric rating (already on 0-100 scale or similar)
 */
export function normalizeNumericRating(rating: number, maxScale: number = 100): number {
  if (maxScale <= 0) throw new Error('Invalid max scale');
  return Math.round((rating / maxScale) * 100);
}

/**
 * Parse numeric rating from string
 * Handles: "85", "85/100", "8.5/10"
 */
export function parseNumericRating(ratingStr: string): { value: number; maxScale: number } | null {
  const normalized = ratingStr.trim();

  // Handle "X/Y" format
  const slashMatch = normalized.match(/^(\d+\.?\d*)\s*\/\s*(\d+)/);
  if (slashMatch) {
    return {
      value: parseFloat(slashMatch[1]),
      maxScale: parseInt(slashMatch[2], 10),
    };
  }

  // Handle plain number (assume 0-100 if > 10, else 0-10)
  const numMatch = normalized.match(/^(\d+\.?\d*)$/);
  if (numMatch) {
    const value = parseFloat(numMatch[1]);
    const maxScale = value > 10 ? 100 : 10;
    return { value, maxScale };
  }

  return null;
}

// ===========================================
// DESIGNATION DETECTION
// ===========================================

/**
 * Detect critic designation from text
 */
export function detectDesignation(text: string): string | undefined {
  for (const { pattern, designation } of DESIGNATION_PATTERNS) {
    if (pattern.test(text)) {
      return designation;
    }
  }
  return undefined;
}

// ===========================================
// MAIN NORMALIZATION FUNCTION
// ===========================================

/**
 * Normalize a raw review to the standard format
 *
 * This function handles all the complexity of converting various
 * rating formats to our standard 0-100 scale.
 *
 * @param raw - The raw review data from a source
 * @param showId - The show ID to associate with
 * @returns Normalized review or null if cannot be normalized
 */
export function normalizeReview(
  raw: RawReview,
  showId: string
): NormalizedReview | null {
  // Find outlet config
  const outletConfig = findOutletConfig(raw.outletName) ||
    (raw.url ? findOutletConfig(raw.url) : undefined);

  if (!outletConfig) {
    console.warn(`Unknown outlet: ${raw.outletName}`);
    // Create a generic tier 3 config for unknown outlets
    // This ensures we don't lose data, but it's flagged as lower tier
  }

  // Determine assigned score based on rating type
  let assignedScore: number | null = null;

  if (raw.originalRating) {
    const ratingStr = raw.originalRating;

    // Try each format in order of specificity
    // 1. Star rating
    const starRating = parseStarRating(ratingStr);
    if (starRating) {
      assignedScore = normalizeStarRating(starRating.stars, starRating.maxStars);
    }

    // 2. Letter grade
    if (assignedScore === null) {
      const letterGrade = parseLetterGrade(ratingStr);
      if (letterGrade) {
        assignedScore = normalizeLetterGrade(letterGrade);
      }
    }

    // 3. Numeric rating
    if (assignedScore === null) {
      const numericRating = parseNumericRating(ratingStr);
      if (numericRating) {
        assignedScore = normalizeNumericRating(numericRating.value, numericRating.maxScale);
      }
    }

    // 4. Text bucket
    if (assignedScore === null) {
      assignedScore = normalizeTextBucket(ratingStr);
    }

    // 5. Thumb rating
    if (assignedScore === null) {
      assignedScore = normalizeThumbRating(ratingStr);
    }
  }

  // If still no score, try to infer from excerpt
  if (assignedScore === null && raw.excerpt) {
    assignedScore = inferSentimentFromText(raw.excerpt);
  }

  // Cannot normalize without a score
  if (assignedScore === null) {
    console.warn(`Could not normalize rating for ${raw.outletName}: ${raw.originalRating}`);
    return null;
  }

  // Clamp score to 0-100
  assignedScore = Math.max(0, Math.min(100, assignedScore));

  // Derive bucket and thumb from score
  const bucket = scoreToBucket(assignedScore);
  const thumb = scoreToThumb(assignedScore);

  // Detect designation
  let designation = raw.designation;
  if (!designation && raw.excerpt) {
    designation = detectDesignation(raw.excerpt);
  }

  // Build normalized review
  const normalized: NormalizedReview = {
    showId,
    outletId: outletConfig?.id || raw.outletName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6),
    outlet: outletConfig?.name || raw.outletName,
    assignedScore,
    bucket,
    thumb,
  };

  // Add optional fields
  if (raw.criticName) normalized.criticName = raw.criticName;
  if (raw.url) normalized.url = raw.url;
  if (raw.publishDate) normalized.publishDate = raw.publishDate;
  if (raw.originalRating) normalized.originalRating = raw.originalRating;
  if (designation) normalized.designation = designation;
  if (raw.excerpt) normalized.pullQuote = raw.excerpt;

  return normalized;
}

// ===========================================
// BATCH NORMALIZATION
// ===========================================

/**
 * Normalize a batch of raw reviews
 */
export function normalizeReviews(
  rawReviews: RawReview[],
  showId: string
): NormalizedReview[] {
  const normalized: NormalizedReview[] = [];

  for (const raw of rawReviews) {
    const review = normalizeReview(raw, showId);
    if (review) {
      normalized.push(review);
    }
  }

  return normalized;
}
