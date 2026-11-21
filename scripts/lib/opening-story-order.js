/**
 * opening-story-order — the single ranking used to decide which opening show
 * leads a newsletter section, so the section's card order and the
 * subject/lede's newsworthiness pick can never disagree about which show is
 * "first" (the WE fix, 2026-08-02: subject said Tao of Glass, cards led with
 * Brainiac Live — londonSection() didn't sort by the same signal
 * newsworthiness.mjs weights its candidates by).
 *
 * Owner decision 2026-10-04 (BRO-3921, newsletter voice): the lead opening is
 * the show that drew the MOST REVIEWS (the one readers are most likely to care
 * about), then the higher score — the same rule weOpeningStories() already
 * used for London. Before this, gold-tier score led, so a small, thinly
 * reviewed show could top the email over the week's marquee opening.
 * newsworthiness.mjs keeps its opening candidates in this input order (see
 * openingRankCap there), so whichever show sorts to position 0 here is also
 * the one the subject and lede lead with.
 */

/**
 * Compares two `{ avg, raw, count }` score-aggregate objects (the shape
 * generate.mjs's aggregateScore() returns): review count desc, then raw
 * score desc.
 */
function compareOpeningStories(aAgg, bAgg) {
  const ac = aAgg?.count ?? 0;
  const bc = bAgg?.count ?? 0;
  if (ac !== bc) return bc - ac;
  const ar = aAgg?.raw ?? aAgg?.avg ?? 0;
  const br = bAgg?.raw ?? bAgg?.avg ?? 0;
  return br - ar;
}

/**
 * Sorts `items` (any shape) into lead order using `getAgg(item)` to read each
 * item's score aggregate. Returns a new array; input is untouched.
 */
function sortOpeningStoriesByNewsworthiness(items, getAgg) {
  return [...items].sort((a, b) => compareOpeningStories(getAgg(a), getAgg(b)));
}

module.exports = { compareOpeningStories, sortOpeningStoriesByNewsworthiness };
