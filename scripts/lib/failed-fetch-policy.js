/**
 * Permanent-failure policy for data/review-texts/failed-fetches.json.
 *
 * Extracted (Scraping cost v3 S2-T5/T6) because collect-review-texts.js
 * implements this decision TWICE — once when recording a failure (~line 6050)
 * and once when loading the ledger to build the permanentlyFailed set (~line
 * 5510) — with a comment asserting the two must agree. A comment is not a
 * mechanism; both call sites now resolve the same function, so they cannot
 * drift (CLAUDE.md rule 15, same reasoning as browserbase-caps.js's single
 * ceiling constant).
 *
 * THE reason this became urgent: the Bright Data circuit breaker (S2-T3) makes
 * a fetch fail for a reason that says nothing about the URL. Without the
 * budget_capped carve-out below, four capped attempts plus one genuine
 * transient failure would permanently retire a perfectly good review URL —
 * the breaker would quietly delete coverage instead of deferring spend. The
 * plan review was explicit that the exclusion must live at the COUNTER (write
 * time), not only at the read threshold: a write-time increment is permanent
 * damage that a read-time filter cannot undo once other reasons accumulate.
 */
'use strict';

/**
 * Failure reasons that reflect OUR spend decisions, not the URL's health.
 * These never increment failureCount and never contribute to retirement.
 */
const SOFT_404_REASON = 'soft_404';
/**
 * The route this URL needs (Browserbase) was never tried because a day/run/
 * domain session cap was already spent (BRO-5222). Before this reason existed
 * those rows were recorded as all_tiers_timeout / all_tiers_failed, counted
 * toward retirement, and 61 WSJ rows were reported as unrecoverable without a
 * single Browserbase attempt.
 */
const ROUTE_CAPPED_REASON = 'route_not_attempted_cap';
/**
 * A row may be deferred for a capped route this many times; the next capped
 * failure is recorded under its ordinary reason and counts. Stops a row whose
 * route is capped every day from being retried forever at no evidence cost.
 */
const MAX_ROUTE_CAPPED_DEFERRALS = 3;
/**
 * A fetch that died on a JavaScript exception in our own code (a TypeError
 * from a bad response shape, say) says nothing about the URL. Before this
 * reason existed such rows were recorded as fetch_error and retired: the
 * Guardian Content API crash ("Cannot read properties of undefined (reading
 * 'length')") left ~360 Guardian reviews skipped after it was fixed
 * (BRO-5933). A row may be deferred as code_error MAX_CODE_ERROR_DEFERRALS
 * times; after that it counts as fetch_error, so a bug that throws after a
 * paid tier ran cannot re-buy the waterfall every run forever.
 */
const CODE_ERROR_REASON = 'code_error';
const MAX_CODE_ERROR_DEFERRALS = 3;

/**
 * Did the fetch die on our own code, not on the page or a scraper tier?
 * Judged from the error object at the throw site: a TypeError/ReferenceError
 * whose message is not the waterfall's aggregate ("All tiers failed: [...]",
 * which quotes each tier's error, page-side Playwright errors included) or a
 * content verdict.
 * @param {unknown} error
 */
function isOwnCodeException(error) {
  if (!(error instanceof TypeError || error instanceof ReferenceError)) return false;
  // Node's own network errors are TypeErrors too ("fetch failed", "Invalid URL"):
  // those are about the URL, not our code.
  return !/^(All tiers failed|URL returned|fetch failed|Invalid URL)/.test(String(error.message || ''));
}

// Legacy rows only keep the first 200 chars of the message and no error type,
// so they are matched on a message that IS a bare exception, start to end.
const LEGACY_CODE_EXCEPTION_RE = /^(?:Cannot read propert(?:y|ies) of (?:undefined|null)\b|Cannot set propert(?:y|ies) of (?:undefined|null)\b|Cannot destructure\b|[\w$.]+ is not (?:a function|iterable|defined)$)/;

const NON_EVIDENCE_REASONS = Object.freeze(['budget_capped', SOFT_404_REASON, ROUTE_CAPPED_REASON, CODE_ERROR_REASON]);

/**
 * The reason to judge a failed-fetches entry by. Rows written before
 * code_error existed carry fetch_error with the exception text in
 * errorMessage; read those as code_error so they are retried (BRO-5933).
 * @param {{failureReason?: string, errorMessage?: string}} entry
 */
function effectiveFailureReason(entry) {
  const reason = (entry && entry.failureReason) || '';
  if (reason === 'fetch_error' && !(entry.codeErrorDeferrals > 0) && LEGACY_CODE_EXCEPTION_RE.test(String(entry.errorMessage || ''))) return CODE_ERROR_REASON;
  return reason;
}

/** @param {string} reason */
function isNonEvidenceFailure(reason) {
  return NON_EVIDENCE_REASONS.includes(reason);
}

/**
 * Should this failure increment the review's failureCount?
 * @param {string} reason
 */
function shouldCountFailure(reason) {
  return !isNonEvidenceFailure(reason);
}

/**
 * Is this failure reason strong evidence the URL itself is bad (as opposed to
 * a transient scraper/network issue)? Single source of truth for the
 * dead/garbage vs everything-else split — consumed by both isPermanentlyFailed
 * (flat threshold) and review-guards.js's shouldRetryFetch (lifecycle-tiered
 * threshold), so the two can never classify the same reason differently
 * (BRO-787 — the lifecycle guard was built by re-deriving this split inline
 * before ship-check caught the drift risk).
 *
 * url_dead_404 / url_dead_410 — the server confirmed the page is gone.
 * garbage_content             — site serves content, but never the review.
 *
 * @param {string} reason
 */
function isStrictFailureReason(reason) {
  return reason === 'garbage_content' || reason === 'url_dead_404' || reason === 'url_dead_410';
}

/**
 * Is this failed-fetches entry retired from future runs?
 *
 * Thresholds (unchanged from the inline logic this replaces):
 *   strict (dead/garbage) → 3 failures
 *   everything else       → 5 failures
 *   budget_capped / route_not_attempted_cap → never (not evidence about the URL)
 *
 * @param {{failureReason?: string, failureCount?: number}} entry
 */
function isPermanentlyFailed(entry) {
  const reason = effectiveFailureReason(entry);
  const count = (entry && entry.failureCount) || 0;
  if (isNonEvidenceFailure(reason)) return false;
  return count >= (isStrictFailureReason(reason) ? 3 : 5);
}

/**
 * Pick the failed-fetches reason for a fetch that threw. Precedence: a
 * confirmed 404 is evidence about the URL and always wins; then a Bright Data
 * budget cap; then a capped Browserbase route; then the generic buckets.
 *
 * @param {object} p
 * @param {string} p.message - the thrown error's message
 * @param {boolean} [p.bdWasCapped] - Bright Data withheld a request this review
 * @param {string|null} [p.routeCapped] - 'day'|'reserve'|'run'|'domain' when the
 *   Browserbase route would have run but a cap blocked it
 * @returns {string}
 */
function classifyFetchFailure({ message, bdWasCapped = false, routeCapped = null, codeError = false }) {
  const msg = String(message || '');
  if (msg.includes('404')) return 'url_dead_404';
  if (codeError) return CODE_ERROR_REASON;
  if (bdWasCapped) return 'budget_capped';
  if (routeCapped) return ROUTE_CAPPED_REASON;
  if (msg.includes('timeout') || msg.includes('TIMEOUT')) return 'all_tiers_timeout';
  if (msg.includes('All tiers failed')) return 'all_tiers_failed';
  return 'fetch_error';
}

/**
 * The Browserbase session-create chokepoint (browserbase-session.js) refuses a
 * session once the account's live daily count passes the ceiling, which it
 * lowers to keep a reserve for shows in their opening window. That refusal is
 * a cap, not evidence against the URL: map it to the same 'day' route-cap the
 * collector's own pre-check records (BRO-5222). Kill switch is not a cap.
 *
 * @param {string} message - error message from fetchWithBrowserbase
 * @param {string|null} [localBlockReason] - browserbaseBlockReason() after the failure
 * @returns {'day'|'reserve'|'run'|'domain'|null}
 */
function routeCapFromBrowserbaseError(message, localBlockReason) {
  const msg = String(message || '');
  if (/Browserbase daily cap reached/.test(msg)) return 'day';
  // BRO-5243: the chokepoint held the recovery reserve back from a non-Tier-1
  // host. Still a cap (deferral), but only for that class of host.
  if (/Browserbase recovery reserve held/.test(msg)) return 'reserve';
  // The collector's own limit check (tripped by a mid-run live resync) throws
  // a generic message; the local block reason says whether it was a cap.
  if (/^Browserbase unavailable/.test(msg) && localBlockReason && localBlockReason !== 'disabled') {
    return localBlockReason;
  }
  return null;
}

/**
 * Apply the capped-route deferral limit before a failure is written.
 * Returns the reason to record and the new cappedDeferrals tally. Past
 * MAX_ROUTE_CAPPED_DEFERRALS the row is recorded as all_tiers_failed (counts).
 *
 * @param {string} reason - from classifyFetchFailure
 * @param {{cappedDeferrals?: number}|null} existing - prior ledger entry
 * @returns {{reason: string, cappedDeferrals: number}}
 */
function applyRouteCapDeferralLimit(reason, existing) {
  if (reason === CODE_ERROR_REASON) {
    const next = ((existing && existing.codeErrorDeferrals) || 0) + 1;
    return { reason: next > MAX_CODE_ERROR_DEFERRALS ? 'fetch_error' : reason, cappedDeferrals: (existing && existing.cappedDeferrals) || 0, codeErrorDeferrals: next };
  }
  const prior = (existing && existing.cappedDeferrals) || 0;
  // Carried through other failures so a real failure in between does not
  // hand a row a fresh code_error budget.
  const codeErrorDeferrals = (existing && existing.codeErrorDeferrals) || 0;
  if (reason !== ROUTE_CAPPED_REASON) return { reason, cappedDeferrals: prior, ...(codeErrorDeferrals ? { codeErrorDeferrals } : {}) };
  const next = prior + 1;
  return { reason: next > MAX_ROUTE_CAPPED_DEFERRALS ? 'all_tiers_failed' : reason, cappedDeferrals: next };
}

/**
 * A capped-route row is not retried on the same UTC day it was capped: the
 * caps reset daily, so a same-day retry would hit the same cap. Targeted runs
 * bypass this through the collector's existing fetch-gate bypass.
 *
 * @param {{failureReason?: string, lastCappedAt?: string}|null} entry
 * @param {Date} [now]
 */
function isRouteCapCooldownActive(entry, now = new Date()) {
  if (!entry || entry.failureReason !== ROUTE_CAPPED_REASON || !entry.lastCappedAt) return false;
  const capped = new Date(entry.lastCappedAt);
  if (Number.isNaN(capped.getTime())) return false;
  return capped.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/**
 * One fresh fetch for a url_content_mismatch recorded under an older version
 * of the content check (BRO-4185 H). Only for a file that still has no
 * usable text and no exclusion flag, and only once per check version (the
 * file stamp survives a lost ledger write).
 *
 * @param {object|null} entry - failed-fetches.json entry
 * @param {object} data - review-text JSON
 * @param {number} currentVersion - URL_CONTENT_CHECK_VERSION
 */
function shouldReopenStaleContentMismatch(entry, data, currentVersion) {
  if (!entry || !data || entry.failureReason !== 'url_content_mismatch') return false;
  if ((entry.checkVersion || 1) >= currentVersion) return false;
  if (data.contentMismatchReopenedFor === currentVersion) return false;
  if (typeof data.fullText === 'string' && data.fullText.length >= 1500) return false;
  if (data.wrongProduction || data.wrongShow || data.isNonReview || data.duplicateOf) return false;
  if (!data.url) return false;
  return true;
}

module.exports = {
  SOFT_404_REASON,
  ROUTE_CAPPED_REASON,
  MAX_ROUTE_CAPPED_DEFERRALS,
  classifyFetchFailure,
  routeCapFromBrowserbaseError,
  applyRouteCapDeferralLimit,
  isRouteCapCooldownActive,
  shouldReopenStaleContentMismatch,
  NON_EVIDENCE_REASONS,
  CODE_ERROR_REASON,
  MAX_CODE_ERROR_DEFERRALS,
  isOwnCodeException,
  effectiveFailureReason,
  isNonEvidenceFailure,
  shouldCountFailure,
  isStrictFailureReason,
  isPermanentlyFailed,
};
