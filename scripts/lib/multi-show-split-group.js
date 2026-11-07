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

function _canonUrl(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * Group key of a split file: its article URL (canonicalised). Any two files
 * flagged as split sections of the same article are siblings, whichever run
 * wrote them (a parent split in one run and a section re-ingested later).
 * null for any file that is not a split section. `showId` is unused and kept
 * for call-site symmetry.
 */
function multiShowSplitGroup(data, showId) { // eslint-disable-line no-unused-vars
  if (!data || typeof data !== 'object') return null;
  if (data.multiShowSplitChild !== true && data.multiShowSplitParent !== true) return null;
  const key = _canonUrl(data.url);
  return key || null;
}

/** True when both files are sections of the same split article. */
function isMultiShowSplitSibling(groupA, groupB) {
  return !!groupA && groupA === groupB;
}

module.exports = { multiShowSplitGroup, isMultiShowSplitSibling };
