/**
 * URL-corrected refetch selection (BRO-5231).
 *
 * A review whose url was corrected (needsRefetch + urlCorrectedFrom) still holds
 * the body and score of the url it was corrected AWAY from. The collector must
 * refetch it even when that stale body looks complete or already carries a
 * score. The "already has good text" short-circuits in collect-review-texts.js
 * skipped these (439 files on 2026-10-13), so needsRefetch never drained.
 *
 * Two follow-ups (2026-10-19):
 *   - Satisfied flag: some writers (the WSJ OTP recovery, archive paths) store
 *     the corrected url's own body without clearing needsRefetch. 131 files had
 *     a body fetched after `_urlChangedClear` moved them to their current url
 *     and were refetched (paid, often Browserbase) after every cooldown.
 *   - Lost flag: needsRefetch is one boolean, and a push-time conflict
 *     resolution can keep the OLD body while taking the cleared flag
 *     (pride-west-end-2026/independent--louis-chilton.json, 2026-10-14: the
 *     2026 review was fetched, the merge kept the 2021 body, needsRefetch went
 *     false). The body itself still says it is the old article: its byline
 *     date is months before publishDate. That content signal cannot be lost.
 */

const { detectBodyDateMismatch } = require('./body-date-mismatch');

const DAY_MS = 86400000;
// Byline this far before publishDate: an older article, not a timezone slip.
const STALE_BODY_MIN_DAYS = 30;
// A stale body refetched without a better result waits this long (the
// failed-fetch ledger also gates it; only the needsRefetch path bypasses that).
const STALE_BODY_COOLDOWN_DAYS = 7;

/**
 * needsRefetch is still set, but the stored body was written after the url
 * correction that moved the file to its CURRENT url, so it is that url's body.
 */
function isRefetchSatisfied(data) {
  if (!data || typeof data.fullText !== 'string' || data.fullText.length === 0) return false;
  const c = data._urlChangedClear;
  if (!c || typeof c !== 'object' || !c.to || c.to !== data.url) return false;
  const fetched = Date.parse(data.textFetchedAt);
  const changed = Date.parse(c.at);
  return Number.isFinite(fetched) && Number.isFinite(changed) && fetched > changed;
}

/**
 * A url-corrected file whose needsRefetch is no longer set but whose body's
 * byline predates publishDate by STALE_BODY_MIN_DAYS or more: the body is the
 * old url's article. Returns the mismatch, or null.
 */
function staleCorrectedBody(data, { now = Date.now() } = {}) {
  // Kill switch: URL_CORRECTED_STALE_BODY_OFF=1 drops this signal (the
  // needsRefetch path is unaffected).
  if (process.env.URL_CORRECTED_STALE_BODY_OFF === '1') return null;
  if (!data || !data.urlCorrectedFrom || data.needsRefetch === true) return null;
  const mismatch = detectBodyDateMismatch(data);
  if (!mismatch || mismatch.deltaDays > -STALE_BODY_MIN_DAYS) return null;
  const fetched = Date.parse(data.textFetchedAt);
  if (Number.isFinite(fetched) && now - fetched < STALE_BODY_COOLDOWN_DAYS * DAY_MS) return null;
  return mismatch;
}

function isUrlCorrectedRefetch(data, opts) {
  if (!data || !data.urlCorrectedFrom) return false;
  if (data.needsRefetch === true) return !isRefetchSatisfied(data);
  return !!staleCorrectedBody(data, opts);
}

/**
 * True when the "complete text" or "scored + reasonable text" short-circuit may
 * skip this review. Never true for a URL-corrected refetch.
 */
function mayShortCircuitCollected(data, { isTruncated, hasGarbageText, datelessDateRetry, scoredSkip, completeSkip }) {
  if (isUrlCorrectedRefetch(data)) {
    // Protected files never clear needsRefetch (the write guard returns early),
    // so bypassing for them would cost a paid fetch on every run.
    return data._locked === true || data.manualContentTier === 'complete'
      ? (completeSkip || scoredSkip)
      : false;
  }
  if (completeSkip && !isTruncated && !hasGarbageText && !datelessDateRetry) return true;
  if (scoredSkip && !isTruncated) return true;
  return false;
}

/**
 * May this selection bypass the failed-fetch retry gate? Only a set
 * needsRefetch (a fresh url correction: the old url's failures say nothing
 * about the new one). A stale-body pick waits out the ledger like any refetch.
 */
function bypassesFetchFailureGate(data) {
  return isUrlCorrectedRefetch(data) && data.needsRefetch === true;
}

module.exports = {
  isUrlCorrectedRefetch,
  isRefetchSatisfied,
  staleCorrectedBody,
  mayShortCircuitCollected,
  bypassesFetchFailureGate,
  STALE_BODY_MIN_DAYS,
  STALE_BODY_COOLDOWN_DAYS,
};
