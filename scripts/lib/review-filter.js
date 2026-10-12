'use strict';
/**
 * REVIEW_FILTER for collect-review-texts.js (BRO-5090).
 *
 * Entries, comma-separated:
 *   nytimes--ben-brantley.json                       bare filename, any show (original form)
 *   les-liaisons-dangereuses-2016/nytimes--ben-brantley.json   one show's file only
 *   force:<either form>                              also refetch when the file already
 *                                                     holds long text (that text came
 *                                                     from the wrong page)
 *
 * The showId/file form lets one run target hundreds of files across shows
 * without the bare-name cross product (every show's nytimes--ben-brantley.json).
 */

/** @returns {{size: number, files: Set<string>, keys: Set<string>, force: Set<string>}} */
function parseReviewFilter(raw) {
  const files = new Set();
  const keys = new Set();
  const force = new Set();
  for (let e of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    let forced = false;
    if (e.startsWith('force:')) { forced = true; e = e.slice('force:'.length).trim(); }
    if (!e) continue;
    (e.includes('/') ? keys : files).add(e);
    if (forced) force.add(e);
  }
  return { size: files.size + keys.size, files, keys, force };
}

/** Is showId/file selected? An empty filter selects everything. */
function matchesReviewFilter(filter, showId, file) {
  if (!filter || filter.size === 0) return true;
  return filter.files.has(file) || filter.keys.has(`${showId}/${file}`);
}

/** Did the filter ask to refetch this file even if it already has good text? */
function isForcedRefetch(filter, showId, file) {
  if (!filter || filter.force.size === 0) return false;
  return filter.force.has(file) || filter.force.has(`${showId}/${file}`);
}

/**
 * A forced refetch that really replaced the stored text (not the same text
 * again, and at least 300 chars, the bar a real page clears in
 * isUnverifiableWebSearchRow) leaves a score read from the wrong page:
 * rescore it.
 */
function shouldRescoreForcedReplacement(review, textBefore, textAfter) {
  if (!review || review._forceRefetch !== true) return false;
  const before = String(textBefore || '').replace(/\s+/g, ' ').trim();
  const after = String(textAfter || '').replace(/\s+/g, ' ').trim();
  return before.length > 0 && after.length >= 300 && before !== after;
}

module.exports = { parseReviewFilter, matchesReviewFilter, isForcedRefetch, shouldRescoreForcedReplacement };
