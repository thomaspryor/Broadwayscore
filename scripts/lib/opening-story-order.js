/**
 * opening-story-order — the single ranking used to decide which opening show
 * leads a newsletter section, so the section's card order and the
 * subject/lede's newsworthiness pick can never disagree about which show is
 * "first" (the WE fix, 2026-08-02: subject said Tao of Glass, cards led with
 * Brainiac Live — londonSection() didn't sort by the same signal
 * newsworthiness.mjs weights its we-gold-opening candidates by).
 *
 * newsworthiness.mjs's bw-opening weight is BASE + (isGoldTier ? GOLD_BUMP : 0)
 * — gold vs non-gold is the only factor, so a section that renders shows in
 * shows.json insertion order can put a non-gold show first even when a gold
 * show opened the same week (BRO-177: broadwayOpenings() had no sort at all).
 * Sorting gold-tier first (raw score, then review count, as tiebreakers)
 * mirrors that weight exactly, so whichever show sorts to position 0 here is
 * also the one newsworthiness.mjs picks first among same-category openings.
 *
 * @param {number|null} score raw composite/avg score (assignedScore avg)
 * @param {number} goldMin gold-tier threshold for the show's category
 */
function isGoldScore(score, goldMin) {
  return typeof score === 'number' && score >= goldMin;
}

/**
 * Compares two `{ avg, raw, count }` score-aggregate objects (the shape
 * generate.mjs's aggregateScore() returns) for newsworthiness order: gold
 * tier first, then raw score desc, then review count desc as a tiebreak when
 * the displayed (rounded) score ties.
 */
function compareOpeningStories(aAgg, bAgg, goldMin) {
  const ag = isGoldScore(aAgg?.avg, goldMin) ? 1 : 0;
  const bg = isGoldScore(bAgg?.avg, goldMin) ? 1 : 0;
  if (ag !== bg) return bg - ag;
  const ar = aAgg?.raw ?? aAgg?.avg ?? 0;
  const br = bAgg?.raw ?? bAgg?.avg ?? 0;
  if (Math.round(ar) === Math.round(br)) return (bAgg?.count ?? 0) - (aAgg?.count ?? 0);
  return br - ar;
}

/**
 * Sorts `items` (any shape) into newsworthiness order using `getAgg(item)` to
 * read each item's score aggregate. Returns a new array; input is untouched.
 */
function sortOpeningStoriesByNewsworthiness(items, getAgg, goldMin) {
  return [...items].sort((a, b) => compareOpeningStories(getAgg(a), getAgg(b), goldMin));
}

module.exports = { isGoldScore, compareOpeningStories, sortOpeningStoriesByNewsworthiness };
