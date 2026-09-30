'use strict';

/**
 * multi-show-split-group.js — identity of the per-show files one multi-show
 * article was split into by multi-show-review-fanout.js (BRO-4431).
 *
 * Those files share the article's URL by design. Every cross-show URL judge
 * (rebuild dedup, cleanup-dedup, gather's cross-production check, the
 * url-ownership create gate used by review-file-writer and the review-texts
 * push validator) must treat SIBLINGS of one split as a single review, while
 * still judging a split file against any unrelated copy of the URL.
 *
 * Dependency-free on purpose: url-ownership.js and review-guards.js both use
 * it, and neither may require the other.
 */

/**
 * The showId the article was originally filed under: a parent's own showId,
 * a child's multiShowSplitParentShowId. null for any other file.
 */
function multiShowSplitGroup(data, showId) {
  if (!data || typeof data !== 'object') return null;
  if (data.multiShowSplitChild === true && data.multiShowSplitParentShowId) return data.multiShowSplitParentShowId;
  if (data.multiShowSplitParent === true) return data.showId || showId || null;
  return null;
}

/** True when both files are sections of the same split article. */
function isMultiShowSplitSibling(groupA, groupB) {
  return !!groupA && groupA === groupB;
}

module.exports = { multiShowSplitGroup, isMultiShowSplitSibling };
