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
 * A partial row's score was read from partial text. When a fetch replaces that
 * text with a substantially longer body, the score must be redone (BRO-5243:
 * truncated WSJ rows completed by the backfill were never rescored, because the
 * excerpt trigger only fires when there was no fullText before). Excerpt, stub
 * and needs-rescrape rows with 500+ chars slipped through both triggers too
 * (BRO-5261). Rows with no tier or an invalid one are left alone.
 */
const PARTIAL_TIERS = new Set(['truncated', 'excerpt', 'stub', 'needs-rescrape']);
function shouldRescoreCompletedTruncated({ tierBefore, hasScore, textBefore, textAfter }) {
  if (!hasScore || !PARTIAL_TIERS.has(tierBefore)) return false;
  const before = String(textBefore || '').replace(/\s+/g, ' ').trim().length;
  const after = String(textAfter || '').replace(/\s+/g, ' ').trim().length;
  return before > 0 && after >= before + 500 && after >= before * 1.25;
}

/**
 * A forced refetch that just pulled this file's text from its own URL on its
 * own outlet's domain must not mark itself `duplicateTextOf` a DIFFERENT
 * outlet's file holding the same text: that sibling is the one carrying the
 * wrong article. BRO-5254: the-lion-king-1997 Variety was refetched with its
 * real text, matched a Vulture file that had held the Variety text since a
 * March misfetch, and the rebuild then dropped the real Variety review while
 * the misattributed Vulture copy stayed live. Cross-outlet copies are left to
 * detect-cross-outlet-duplicates.js, which picks the primary by tier/length.
 * `hostMatches` is outlet-domain-validation's hostMatchesOutletDomain result
 * for this file (true only on a registered domain match). `forcedRefetch` is
 * the operator's force: flag, whether or not the text changed: a refetch that
 * returns the same text must still be able to clear the wrong pointer.
 */
function skipCrossOutletSelfDemote({ forcedRefetch, outletId, siblingOutletId, hostMatches }) {
  return !!(forcedRefetch && hostMatches === true && outletId && siblingOutletId && outletId !== siblingOutletId);
}

/**
 * BRO-5348: a crossOutletDuplicate flag set while the row held another
 * outlet's text outlives a forced refetch that restored the row's own text,
 * and keeps the real review hidden (merrily-we-roll-along-2023 amNY). Clear it
 * when the refetch replaced the text and the new text no longer matches the
 * flagged primary. An unreadable primary (no fingerprint) and a similarity
 * flag keep the flag.
 */
function staleCrossOutletFlagAfterRefetch({ forcedReplacement, crossOutletDuplicate, crossOutletMethod, newFingerprint, primaryFingerprint }) {
  // Only an exact-fingerprint flag: a similarity flag's fingerprint differs from
  // its primary by construction, so a fingerprint change proves nothing there.
  return !!(forcedReplacement && crossOutletDuplicate === true && crossOutletMethod === 'fingerprint'
    && newFingerprint && primaryFingerprint && newFingerprint !== primaryFingerprint);
}

module.exports = { parseReviewFilter, matchesReviewFilter, isForcedRefetch, shouldRescoreForcedReplacement, shouldRescoreCompletedTruncated, forcedRefetchTrim, FORCED_REFETCH_TRIM_REASON, skipCrossOutletSelfDemote, staleCrossOutletFlagAfterRefetch };
