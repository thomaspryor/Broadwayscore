/**
 * Star-rating reliability classification.
 *
 * Mirrors the LOW_RELIABILITY_EXTRACTION set in scripts/lib/rebuild-helpers.js
 * so write-time anchored-band scoring (Sprint 3, scripts/llm-scoring/ensemble-scorer.ts)
 * uses the same reliability gate as read-time score precedence (rebuild-helpers).
 *
 * **Mirror, not source of truth (yet).** When Sprint 5 cleanup runs, the
 * rebuild-helpers local set should be replaced with `require(this file)` so
 * there's a single definition. Until then, keep both in sync manually — a
 * grep test in the unit suite would catch drift.
 */

'use strict';

const { OUTLET_STAR_AUTHORITATIVE } = require('./score-extractors');

// Star-extraction sources that produce false positives often enough to gate
// against (CSS class names with no schema, ad-hoc text patterns, etc.).
// Reviews extracted via these methods enter Sprint 3's UNANCHORED LLM path —
// the LLM scores prose without a band constraint.
const LOW_RELIABILITY_EXTRACTION = new Set([
  'css-stars', 'star-class', 'css-rating', 'star-rating',
  'text-pattern', 'og-description', 'wp-api-title',
  'numeric-stars', // generic "X/5" pattern — false positives from pagination, dates, URLs
]);

/**
 * @param {object} data - review-text JSON contents (must include scoreSource + outletId)
 * @returns {boolean} true if the originalScore was extracted via a trusted source.
 */
function isHighReliabilityStar(data) {
  if (!data) return false;
  // Outlet on the authoritative list bypasses the low-reliability gate —
  // these outlets have dedicated extractors with verified extraction patterns.
  if (OUTLET_STAR_AUTHORITATIVE.has(data.outletId)) return true;
  // Otherwise the source string must not be in the low-rel set.
  return !LOW_RELIABILITY_EXTRACTION.has(data.scoreSource);
}

/**
 * Detect a star or letter-grade band from a review-text file.
 *
 * Returns:
 *   { band: ScoreBand-shape, starsRaw: string, kind: 'star'|'letter-grade', highReliability: boolean }
 * or null when no band could be extracted (no star/grade in any field).
 *
 * Caller decides whether to USE the band based on highReliability + their
 * own policy. Sprint 3 policy: high-rel → anchored (V6 with band);
 * low-rel → unanchored (V6 prompt, no band).
 *
 * @param {object} data - review-text JSON contents
 */
function detectBandFromReviewFile(data) {
  if (!data) return null;

  // Try star fields in priority order. starRating + originalRating are
  // primary-source extractions; aggregatorStars is relayed (lower trust).
  const candidates = [
    { value: data.starRating, source: 'starRating' },
    { value: data.originalRating, source: 'originalRating' },
    { value: data.aggregatorStars, source: 'aggregatorStars' },
  ];

  for (const { value } of candidates) {
    if (value === null || value === undefined || value === '') continue;
    const raw = String(value);

    // Numeric star pattern: "4/5", "3.5/4", "4 out of 5"
    const num = raw.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i);
    if (num) {
      const stars = parseFloat(num[1]);
      const max = parseFloat(num[2]);
      if (Number.isFinite(stars) && Number.isFinite(max) && stars >= 0 && max > 0 && stars <= max) {
        const fraction = stars / max;
        let band;
        if (fraction >= 0.9) band = { floor: 91, ceiling: 100 };
        else if (fraction >= 0.7) band = { floor: 71, ceiling: 90 };
        else if (fraction >= 0.5) band = { floor: 51, ceiling: 70 };
        else if (fraction >= 0.3) band = { floor: 31, ceiling: 50 };
        else band = { floor: 0, ceiling: 30 };
        return {
          band: { fraction, floor: band.floor, ceiling: band.ceiling },
          starsRaw: raw,
          kind: 'star',
          highReliability: isHighReliabilityStar(data),
        };
      }
    }

    // Letter grade: longest-alternation first (`A-` doesn't truncate to `A`).
    const lg = raw.match(/(A\+|A-|B\+|B-|C\+|C-|D\+|D-|A|B|C|D|F)(?:\b|$)/);
    if (lg) {
      const grade = lg[1].toUpperCase();
      const table = {
        'A+': [95, 100], 'A':  [89, 94], 'A-': [83, 88],
        'B+': [77, 82],  'B':  [71, 76], 'B-': [65, 70],
        'C+': [59, 64],  'C':  [53, 58], 'C-': [47, 52],
        'D+': [41, 46],  'D':  [35, 40], 'D-': [29, 34],
        'F':  [0,  28],
      };
      const range = table[grade];
      if (range) {
        // fraction:-1 is a sentinel meaning "letter grade, no percentage available".
        // buildAnchoredBandBlock in config.ts handles this by omitting the percentage clause.
        return {
          band: { fraction: -1, floor: range[0], ceiling: range[1] },
          starsRaw: raw,
          kind: 'letter-grade',
          highReliability: isHighReliabilityStar(data),
        };
      }
    }
  }

  return null;
}

module.exports = {
  LOW_RELIABILITY_EXTRACTION,
  isHighReliabilityStar,
  detectBandFromReviewFile,
};
