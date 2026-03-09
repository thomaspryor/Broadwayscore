/**
 * Single source of truth for all excerpt field names.
 *
 * IMPORTANT: When adding a new excerpt type (e.g. from a new aggregator),
 * add it here and ALL scripts will pick it up automatically.
 * Run: grep -rn "excerptFields\|hasExcerpt\|EXCERPT_FIELDS" scripts/
 * to find any hardcoded lists that need updating.
 */

const EXCERPT_FIELDS = [
  'dtliExcerpt',
  'bwwExcerpt',
  'showScoreExcerpt',
  'nycTheatreExcerpt',
  'lboRoundupExcerpt',
];

/**
 * Check if a review data object has any excerpt.
 * @param {object} data - Review data object
 * @returns {boolean}
 */
function hasExcerpt(data) {
  return EXCERPT_FIELDS.some(f => !!data[f]);
}

/**
 * Get all non-empty excerpts from a review data object.
 * @param {object} data - Review data object
 * @returns {string[]}
 */
function getExcerpts(data) {
  return EXCERPT_FIELDS.map(f => data[f]).filter(Boolean);
}

/**
 * Get the longest excerpt from a review data object.
 * @param {object} data - Review data object
 * @returns {string}
 */
function getLongestExcerpt(data) {
  return EXCERPT_FIELDS.reduce((best, f) => {
    const val = data[f] || '';
    return val.length > best.length ? val : best;
  }, '');
}

module.exports = { EXCERPT_FIELDS, hasExcerpt, getExcerpts, getLongestExcerpt };
