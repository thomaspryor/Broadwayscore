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
 * The outlet's known `starScale` (from outlet-registry) is used ONLY as a
 * fallback when the rating string itself omits the denominator (e.g.,
 * bare "4 stars" or "★★★★" with no empty stars). When a denominator IS
 * present in the string, it always wins — explicit > hint.
 *
 * Real-world trigger: The Recs / Celebrity Autobiography 2026-05-20.
 * Gemini parsed the article header "★★★★" as "4/4 stars" and the score
 * shipped as 100 (Rave) instead of 80 (Positive). The Recs rates out of 5.
 * Pass `maxStarsHint` from outlet-registry.starScale to fix this class.
 *
 * @param {string} rating - The rating string to parse
 * @param {{maxStarsHint?: number}} [opts] - Outlet-derived hint for bare ratings
 * @returns {number|null} Score 0-100, or null if not a star rating
 */
function parseStarRating(rating, opts) {
  if (!rating) return null;
  const r = rating.toString().trim();
  const hint = opts && Number.isFinite(opts.maxStarsHint) ? opts.maxStarsHint : null;

  // "X/Y", "X out of Y", "X stars" — multi-digit value AND scale
  const starMatch = r.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)|out\s+of\s+(\d+)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    // Explicit denominator > outlet hint > default 5
    const denomFromString = starMatch[2] || starMatch[3];
    const maxStars = denomFromString ? parseInt(denomFromString, 10) : (hint || 5);
    if (maxStars > 0 && stars <= maxStars) {
      return Math.round((stars / maxStars) * 100);
    }
    return null; // value > scale is invalid
  }

  // Unicode star symbols: ★★★☆☆.
  // Denominator preference:
  //   1. empty-glyph count present → filled+empty is the explicit scale (e.g. ★★★☆☆ = 5)
  //   2. otherwise → outlet hint (e.g. The Recs ★★★★ + hint=5 → 80)
  //   3. fallback to 5
  // The Recs canonical bug case: ★★★★ alone shows nothing about the scale.
  // Counting only filled glyphs as the denominator would say 4/4 = 100.
  const filledStars = (r.match(/★/g) || []).length;
  const emptyStars = (r.match(/☆/g) || []).length;
  if (filledStars > 0) {
    const total = emptyStars > 0 ? (filledStars + emptyStars) : (hint || 5);
    if (filledStars > total) return null;
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
 * The outlet-registry hook: when called from rebuild-all-reviews.js with
 * outletId, the wrapper looks up `starScale` in outlet-registry.json once
 * per call and threads it as the maxStarsHint to parseStarRating. This is
 * the fix path for the The Recs / Celebrity Autobiography 2026-05-20 case.
 *
 * @param {string} rating - The rating string
 * @param {string} [outletId] - Outlet ID for letter-grade gating + starScale lookup
 * @param {{outletRegistry?: object}} [opts] - Optional dependency-injected registry
 *   (defaults to lazy-loading data/outlet-registry.json). Tests pass a fixture.
 * @returns {number|null} Score 0-100, or null if unparseable
 */
let _outletRegistryCache = null;
function getOutletRegistry(opts) {
  if (opts && opts.outletRegistry) return opts.outletRegistry;
  if (_outletRegistryCache) return _outletRegistryCache;
  try {
    const path = require('path');
    const fs = require('fs');
    const p = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
    _outletRegistryCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return _outletRegistryCache;
  } catch {
    return null;
  }
}

function getStarScaleForOutlet(outletId, opts) {
  if (!outletId) return null;
  const reg = getOutletRegistry(opts);
  if (!reg || !reg.outlets) return null;
  const entry = reg.outlets[outletId];
  // Guard against bad data: starScale must be a positive finite number.
  // A bare 0 or string "5" or NaN would silently produce wrong results
  // (Infinity / NaN propagating into normalized scores).
  if (!entry || !Number.isFinite(entry.starScale) || entry.starScale <= 0) return null;
  return entry.starScale;
}

function parseOriginalScore(rating, outletId, opts) {
  if (!rating) return null;

  const maxStarsHint = getStarScaleForOutlet(outletId, opts);
  const starScore = parseStarRating(rating, { maxStarsHint });
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
