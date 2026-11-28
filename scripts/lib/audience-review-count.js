/**
 * Visible audience review count (BRO-6738). Mirrors getTotalAudienceReviews in
 * src/lib/audience-grade-utils.ts. Only sources used by calculateCombinedScore
 * count toward the grade minimum, including its volume, market and recency gates.
 */
const { isSourceActive } = require('./audience-weighting');

function countVisibleAudienceReviews(sources, showInfo) {
  let total = 0;
  for (const [name, source] of Object.entries(sources || {})) {
    if (isSourceActive(name, source, showInfo)) total += source.reviewCount;
  }
  return total;
}
module.exports = { countVisibleAudienceReviews };
