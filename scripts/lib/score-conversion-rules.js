/**
 * Score Conversion Rules
 *
 * Defines the canonical conversion rules from original ratings to assigned scores.
 * Used for auditing existing scores and ensuring consistency.
 *
 * Created as part of Sprint 3 - Score Conversion Audit
 */

/**
 * Letter grade to score conversions (100-point scale)
 */
const LETTER_GRADES = {
  'A+': 97,
  'A': 93,
  'A-': 90,
  'B+': 87,
  'B': 83,
  'B-': 80,
  'C+': 77,
  'C': 73,
  'C-': 70,
  'D+': 67,
  'D': 60,
  'D-': 57,
  'F': 50
};

/**
 * Star ratings out of 5
 */
const STARS_OUT_OF_5 = {
  5: 100,
  4.5: 90,
  4: 80,
  3.5: 70,
  3: 60,
  2.5: 50,
  2: 40,
  1.5: 30,
  1: 20,
  0.5: 10,
  0: 0
};

/**
 * Star ratings out of 4
 */
const STARS_OUT_OF_4 = {
  4: 100,
  3.5: 88,
  3: 75,
  2.5: 63,
  2: 50,
  1.5: 38,
  1: 25,
  0.5: 13,
  0: 0
};

/**
 * Sentiment-based ratings
 */
const SENTIMENT_RATINGS = {
  'rave': 90,
  'positive': 75,
  'mixed': 60,
  'negative': 40,
  'pan': 25
};

/**
 * Thumb-based ratings
 */
const THUMB_RATINGS = {
  'up': 80,
  'meh': 60,
  'flat': 60,
  'down': 40
};

/**
 * Designation-only entries that are NOT scoreable
 * These represent bumps/bonuses, not base scores
 */
const DESIGNATION_ONLY_PATTERNS = [
  /^recommended$/i,
  /^critics?[\s_-]?pick$/i,
  /^must[\s_-]?see$/i,
  /^editor'?s?[\s_-]?choice$/i,
  /^highly[\s_-]?recommended$/i,
  /^essential$/i,
  /^critics?[\s_-]?choice$/i
];

/**
 * Parse an original rating and return its expected score.
 *
 * @param {string|number} originalRating - The original rating value
 * @returns {object} - { type, expected, parsedValue, unparseable }
 */
function parseRating(originalRating) {
  if (originalRating === null || originalRating === undefined || originalRating === '') {
    return { type: 'null', expected: null, parsedValue: null, unparseable: false };
  }

  const rating = String(originalRating).trim();

  // Check if it's a designation-only entry (not scoreable)
  for (const pattern of DESIGNATION_ONLY_PATTERNS) {
    if (pattern.test(rating)) {
      return { type: 'designation', expected: null, parsedValue: rating, unparseable: false, isDesignation: true };
    }
  }

  // Check if it's already a numeric score (0-100)
  const numericMatch = rating.match(/^(\d+(?:\.\d+)?)$/);
  if (numericMatch) {
    const value = parseFloat(numericMatch[1]);
    if (value >= 0 && value <= 100) {
      return { type: 'numeric', expected: value, parsedValue: value, unparseable: false };
    }
  }

  // Check for letter grades (including ranges like B+/A-)
  const letterRangeMatch = rating.match(/^([A-DF][+-]?)\s*(?:\/|to)\s*([A-DF][+-]?)$/i);
  if (letterRangeMatch) {
    const grade1 = letterRangeMatch[1].toUpperCase();
    const grade2 = letterRangeMatch[2].toUpperCase();
    const score1 = LETTER_GRADES[grade1];
    const score2 = LETTER_GRADES[grade2];
    if (score1 !== undefined && score2 !== undefined) {
      const average = (score1 + score2) / 2;
      return { type: 'letter_range', expected: average, parsedValue: `${grade1}/${grade2}`, unparseable: false };
    }
  }

  // Check for single letter grade
  const letterMatch = rating.match(/^([A-DF][+-]?)$/i);
  if (letterMatch) {
    const grade = letterMatch[1].toUpperCase();
    const score = LETTER_GRADES[grade];
    if (score !== undefined) {
      return { type: 'letter', expected: score, parsedValue: grade, unparseable: false };
    }
  }

  // Check for star ratings with various formats
  // "X out of Y", "X/Y", "X stars", "X star", "X/Y stars"

  // Pattern: "X out of Y" or "X/Y"
  const starFractionMatch = rating.match(/^(\d+(?:\.\d+)?)\s*(?:out\s*of|\/)\s*(\d+)\s*(?:stars?)?$/i);
  if (starFractionMatch) {
    const value = parseFloat(starFractionMatch[1]);
    const outOf = parseInt(starFractionMatch[2]);
    return convertStarRating(value, outOf);
  }

  // Pattern: "X stars" or "X star" (assumed out of 5)
  const starOnlyMatch = rating.match(/^(\d+(?:\.\d+)?)\s*stars?$/i);
  if (starOnlyMatch) {
    const value = parseFloat(starOnlyMatch[1]);
    return convertStarRating(value, 5);
  }

  // Check for sentiment-based ratings
  // "Rave", "Positive", "Mixed", "Negative", "Pan"
  // Also handle "Sentiment: Positive" format
  const sentimentMatch = rating.match(/^(?:Sentiment:\s*)?(Rave|Positive|Mixed|Negative|Pan)$/i);
  if (sentimentMatch) {
    const sentiment = sentimentMatch[1].toLowerCase();
    const score = SENTIMENT_RATINGS[sentiment];
    if (score !== undefined) {
      return { type: 'sentiment', expected: score, parsedValue: sentiment, unparseable: false };
    }
  }

  // Check for thumb ratings
  const thumbMatch = rating.match(/^(Up|Down|Meh|Flat)$/i);
  if (thumbMatch) {
    const thumb = thumbMatch[1].toLowerCase();
    const score = THUMB_RATINGS[thumb];
    if (score !== undefined) {
      return { type: 'thumb', expected: score, parsedValue: thumb, unparseable: false };
    }
  }

  // Could not parse
  return { type: 'unknown', expected: null, parsedValue: rating, unparseable: true };
}

/**
 * Convert a star rating to a 0-100 score
 *
 * @param {number} stars - The star value
 * @param {number} outOf - The maximum stars (4 or 5)
 * @returns {object}
 */
function convertStarRating(stars, outOf) {
  let lookupTable;

  if (outOf === 5) {
    lookupTable = STARS_OUT_OF_5;
  } else if (outOf === 4) {
    lookupTable = STARS_OUT_OF_4;
  } else {
    // For non-standard scales, calculate proportionally
    const expected = Math.round((stars / outOf) * 100);
    return { type: 'star_custom', expected, parsedValue: `${stars}/${outOf}`, unparseable: false };
  }

  // Try exact lookup first
  if (lookupTable[stars] !== undefined) {
    return { type: `star_${outOf}`, expected: lookupTable[stars], parsedValue: `${stars}/${outOf}`, unparseable: false };
  }

  // For values between, interpolate
  const expected = Math.round((stars / outOf) * 100);
  return { type: `star_${outOf}`, expected, parsedValue: `${stars}/${outOf}`, unparseable: false };
}

/**
 * Validate a score conversion.
 *
 * @param {string|number} originalRating - The original rating value
 * @param {number} assignedScore - The score that was assigned
 * @param {number} tolerance - Maximum allowed difference (default 10)
 * @returns {object} - { valid, expected, difference, parseResult }
 */
function validateScore(originalRating, assignedScore, tolerance = 10) {
  const parseResult = parseRating(originalRating);

  // Skip validation for null/missing ratings
  if (parseResult.type === 'null') {
    return { valid: true, expected: null, difference: null, parseResult, skipped: true, reason: 'null_rating' };
  }

  // Skip validation for designation-only entries
  if (parseResult.isDesignation) {
    return { valid: true, expected: null, difference: null, parseResult, skipped: true, reason: 'designation_only' };
  }

  // Flag as unparseable if we couldn't understand the format
  if (parseResult.unparseable) {
    return { valid: false, expected: null, difference: null, parseResult, skipped: false, reason: 'unparseable' };
  }

  // Calculate difference
  const expected = parseResult.expected;
  const difference = Math.abs(expected - assignedScore);
  const valid = difference <= tolerance;

  return {
    valid,
    expected,
    difference,
    parseResult,
    skipped: false,
    reason: valid ? 'correct' : 'miscalculated'
  };
}

/**
 * Get the expected score for a given original rating.
 * Returns null if the rating cannot be parsed.
 *
 * @param {string|number} originalRating
 * @returns {number|null}
 */
function getExpectedScore(originalRating) {
  const result = parseRating(originalRating);
  return result.expected;
}

module.exports = {
  LETTER_GRADES,
  STARS_OUT_OF_5,
  STARS_OUT_OF_4,
  SENTIMENT_RATINGS,
  THUMB_RATINGS,
  DESIGNATION_ONLY_PATTERNS,
  parseRating,
  validateScore,
  getExpectedScore
};
