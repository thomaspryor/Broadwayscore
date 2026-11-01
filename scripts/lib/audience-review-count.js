/**
 * Visible audience review count (BRO-6738). Mirrors getTotalAudienceReviews in
 * src/lib/audience-grade-utils.ts: sources flagged suppressed:true (generic-title
 * contamination, tiles hidden on the site) and sources with no score never count
 * toward the Audience Grade minimum, so a grade can never rest on hidden sources.
 */
function countVisibleAudienceReviews(sources) {
  let total = 0;
  for (const s of Object.values(sources || {})) {
    if (!s || s.suppressed || s.score == null) continue;
    total += s.reviewCount || 0;
  }
  return total;
}
module.exports = { countVisibleAudienceReviews };
