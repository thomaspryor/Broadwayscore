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

/**
 * A forced refetch that brings back SHORTER text (the stored copy carried page
 * chrome or another article) must say so on the record, or the push restore
 * reads the old longer copy as richer content and puts it back
 * (review-write-guard _deliberateTextTrim). BRO-5254: all 10 Variety refetches
 * were reverted this way. Returns the breadcrumb, or null when nothing shrank.
 */
const FORCED_REFETCH_TRIM_REASON = 'forced refetch replaced wrong-page text (BRO-5254)';
function forcedRefetchTrim(textBefore, textAfter, at) {
  if (typeof textBefore !== 'string' || typeof textAfter !== 'string' || !textAfter) return null;
  if (textAfter.length >= textBefore.length) return null;
  return { reason: FORCED_REFETCH_TRIM_REASON, fromLength: textBefore.length, toLength: textAfter.length, at: at || new Date().toISOString() };
}

/**
 * A truncated row's score was read from partial text. When a fetch replaces that
 * text with a substantially longer body, the score must be redone (BRO-5243:
 * truncated WSJ rows completed by the backfill were never rescored, because the
 * excerpt trigger only fires when there was no fullText before).
 */
function shouldRescoreCompletedTruncated({ tierBefore, hasScore, textBefore, textAfter }) {
  if (!hasScore || tierBefore !== 'truncated') return false;
  const before = String(textBefore || '').replace(/\s+/g, ' ').trim().length;
  const after = String(textAfter || '').replace(/\s+/g, ' ').trim().length;
  return before > 0 && after >= before + 500 && after >= before * 1.25;
}

module.exports = { parseReviewFilter, matchesReviewFilter, isForcedRefetch, shouldRescoreForcedReplacement, shouldRescoreCompletedTruncated, forcedRefetchTrim, FORCED_REFETCH_TRIM_REASON };
