/**
 * Shared Score Parsers — single source of truth for all rating-to-score conversions.
 *
 * EVERY script that parses star ratings, letter grades, or numeric scores
 * MUST import from here. No inline parsers allowed.
 *
 * Canonical letter grades come from score-extractors.js (aligned with src/config/scoring.ts).
 */

const { LETTER_GRADES } = require('./score-extractors');

// Outlets that use letter grade scoring (from src/config/scoring.ts scoreFormat: 'letter').
// Letter grades from other outlets are rejected by parseOriginalScore to prevent cross-contamination.
const LETTER_GRADE_OUTLETS = new Set(['ew', 'jks-theatre-scene', 'gotham-playgoer']);

/**
 * Parse a star rating string to 0-100.
 * Handles: "4/5", "3.5/10", "4 out of 5", "3 stars", "★★★★☆"
 *
 * @param {string} rating - The rating string to parse
 * @returns {number|null} Score 0-100, or null if not a star rating
 */
function parseStarRating(rating) {
  if (!rating) return null;
  const r = rating.toString().trim();

  // "X/Y", "X out of Y", "X stars" — multi-digit value AND scale
  const starMatch = r.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)|out\s+of\s+(\d+)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = parseInt(starMatch[2] || starMatch[3] || '5');
    if (maxStars > 0 && stars <= maxStars) {
      return Math.round((stars / maxStars) * 100);
    }
    return null; // value > scale is invalid
  }

  // Unicode star symbols: ★★★☆☆
  const filledStars = (r.match(/★/g) || []).length;
  const emptyStars = (r.match(/☆/g) || []).length;
  if (filledStars > 0) {
    const total = filledStars + emptyStars || 5;
    return Math.round((filledStars / total) * 100);
  }

  return null;
}

/**
 * Parse a letter grade to 0-100 using the canonical LETTER_GRADES map.
 *
 * @param {string} rating - The rating string (e.g. "A+", "B-", "Grade: A")
 * @returns {number|null} Score 0-100, or null if not a letter grade
 */
function parseLetterGrade(rating) {
  if (!rating) return null;
  const r = rating.toString().trim().toUpperCase();

  // Direct match: "A+", "B-", "F"
  if (LETTER_GRADES[r] !== undefined) {
    return LETTER_GRADES[r];
  }

  // Standalone grade pattern: must be the entire string
  const letterMatch = r.match(/^([A-D][+-]?|F)$/);
  if (letterMatch) {
    return LETTER_GRADES[letterMatch[1]] || null;
  }

  return null;
}

/**
 * Parse a numeric score (plain number or X/100) to 0-100.
 *
 * @param {string} rating - The rating string
 * @returns {number|null} Score 0-100, or null if not a numeric score
 */
function parseNumericRating(rating) {
  if (!rating) return null;
  const r = rating.toString().trim();

  // "90%" or "90" or "90/100"
  const numMatch = r.match(/^(\d+)\s*(?:%|\/\s*100)?$/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    if (num >= 0 && num <= 100) return num;
  }

  return null;
}

/**
 * Parse any original rating to 0-100. Tries star → letter → numeric.
 * Letter grades are only accepted from outlets in LETTER_GRADE_OUTLETS.
 *
 * @param {string} rating - The rating string
 * @param {string} [outletId] - Outlet ID for letter-grade gating
 * @returns {number|null} Score 0-100, or null if unparseable
 */
function parseOriginalScore(rating, outletId) {
  if (!rating) return null;

  const starScore = parseStarRating(rating);
  if (starScore !== null) return starScore;

  const letterScore = parseLetterGrade(rating);
  if (letterScore !== null) {
    // Only accept letter grades from outlets that actually use them
    if (outletId && !LETTER_GRADE_OUTLETS.has(outletId)) {
      return null;
    }
    return letterScore;
  }

  return parseNumericRating(rating);
}

/**
 * Normalize an LLM-extracted score result to a canonical format.
 * Used by extract-explicit-ratings.js and llm-score-extractor.js.
 *
 * @param {{ value: number, scale: number, type: string, raw: string }} result
 * @returns {{ originalScore: string, normalizedScore: number, type: string, raw: string }|null}
 */
function normalizeLlmResult(result) {
  if (!result) return null;
  const { value, scale, type, raw } = result;

  // Reject impossible values (LLM miscounted asterisks, etc.)
  if (value > scale) return null;

  if (type === 'letter') {
    // Extract grade from raw text. \b at start prevents matching letters inside words (e.g. "Abrams").
    // (?!\w) at end ensures we don't match partial words, while allowing +/- modifiers.
    const gradeMatch = raw.match(/\b([A-D][+\-–—]?|F)(?!\w)/i);
    if (gradeMatch) {
      const grade = gradeMatch[1].toUpperCase().replace(/[–—]/g, '-');
      if (LETTER_GRADES[grade] !== undefined) {
        return {
          originalScore: grade,
          normalizedScore: LETTER_GRADES[grade],
          type: 'letter',
          raw
        };
      }
    }
    // Fallback: use the numeric value from LLM if on 100-scale
    if (scale === 100) {
      return { originalScore: raw, normalizedScore: Math.round(value), type: 'letter', raw };
    }
  }

  if (type === 'stars') {
    const normalizedScore = Math.round((value / scale) * 100);
    return {
      originalScore: `${value}/${scale} stars`,
      normalizedScore,
      type: 'stars',
      raw
    };
  }

  if (type === 'numeric') {
    const normalizedScore = scale === 100 ? Math.round(value) : Math.round((value / scale) * 100);
    return {
      originalScore: `${value}/${scale}`,
      normalizedScore,
      type: 'numeric',
      raw
    };
  }

  return null;
}

module.exports = {
  parseStarRating,
  parseLetterGrade,
  parseNumericRating,
  parseOriginalScore,
  normalizeLlmResult,
  LETTER_GRADE_OUTLETS,
  // Re-export for callers that need the raw map
  LETTER_GRADES,
};
