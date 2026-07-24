/**
 * Pure decision logic for the self-healing review-recovery write-loop in
 * scripts/audit-show-review-gap.js.
 *
 * Background: the hourly aggregator-gap audit already auto-ingests reviews an
 * aggregator lists that have NO local file (result.missing). It never touched
 * flaggedMisses — reviews where a file EXISTS but is empty-body / broken, so the
 * rebuild drops them for low content-tier. That is the gap that lets a fresh
 * opening land "short" (Glengarry WE 10-12 vs ~19 real): a paywalled review gets
 * a discovered URL, the fetch returns an empty body, the file is written but
 * never becomes includable.
 *
 * This module is the merge-SAFE half of the recovery decision (CLAUDE.md §15:
 * extract the real decision function so the write-loop and its unit test share
 * one implementation). It decides ONLY the empty-body case, which heals by
 * re-fetching the aggregator's current-production URL and letting
 * createOrMergeReviewFile MERGE the freshly-fetched text into the existing empty
 * file (a fill, never a clobber).
 *
 * The riskier stale-slug wrongProduction case is deliberately NOT handled here —
 * see the deferral note in audit-show-review-gap.js for why auto-clobbering a
 * wrongProduction file in an unattended hourly job is unsafe.
 *
 * Pure: no I/O, no requires of data files.
 */

'use strict';

// Max auto-recovery re-fetches per file before we stop retrying. Prevents an
// hourly re-fetch loop on a paywall/dead URL that never heals (which would burn
// scraper credits forever). The loop MUST persist aggUrlRecoveryCount to the
// file on EVERY attempt — including fetch failure — or this cap can never bite.
const FLAGGED_RECOVERY_CAP = 3;

// A dir file is "empty body" when the rebuild would drop it for lack of usable
// content: no fullText at the 400-char includability floor, no aggregator star
// score, and no assigned score. Mirrors the emptyBody arm of classifyShowFile in
// audit-show-review-gap.js — kept in lockstep so detection and recovery agree.
function isEmptyBodyFile(d) {
  if (!d) return false;
  return !(d.fullText && d.fullText.length >= 400) && !d.aggregatorStars && d.assignedScore == null;
}

// A flagged-out dir file is auto-recoverable ONLY in the merge-safe empty-body
// case: no usable fullText/stars/score, no wrong-production / wrong-show flag, no
// human protection, and under the retry cap. Re-fetching the aggregator's
// current-production URL then just FILLS the missing text. Stale-slug
// wrongProduction recovery needs a destructive clear-then-reingest and is NOT
// handled here.
function isRecoverableFlaggedFile(d, cap = FLAGGED_RECOVERY_CAP) {
  if (!d) return false;
  if (d.humanReviewScore != null) return false;             // human-set — never clobber
  if (d.wrongProduction === true || d.wrongShow === true) return false; // not merge-safe
  if (d.wrongProductionManualClear === true || d.wrongShowManualClear === true) return false;
  if (d.humanReviewedWrongProduction === false) return false; // human verified RIGHT production
  if ((d.aggUrlRecoveryCount || 0) >= cap) return false;
  return isEmptyBodyFile(d);
}

// Generic "this URL is an individual review page" marker — path segment or slug
// containing review/reviews. Used to (a) keep garbage URLs (Facebook posts,
// news announcements) OUT of the uncited-stub retry pool and (b) detect when a
// non-review classification was made on a page whose URL says review (the
// classifier judged failed-extraction boilerplate, not the article).
const REVIEW_URL_MARKER = /(^|[/.-])reviews?([/.-]|$)/i;
// Social/UGC hosts whose post slugs often quote "reviews are in" — a Facebook
// post is never the outlet's review page, whatever its slug says (real-corpus
// scan 2026-07-23: facebook.com/.../heavenly-reviews-jesus-christ-superstar…).
const SOCIAL_HOSTS = /(^|\.)(facebook|twitter|x|instagram|reddit|tiktok|youtube|threads)\.(com|net)$/i;
function looksLikeReviewUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative or malformed URL — not refetchable, not a review page
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (SOCIAL_HOSTS.test(parsed.hostname)) return false;
  return REVIEW_URL_MARKER.test(parsed.pathname);
}

// RC2 guard (Radio Times, 2026-07-23): the enrich-reviews classifier stamped a
// terminal isNonReview=true on 517 chars of subscription-ad boilerplate scraped
// from a real review URL (/going-out-reviews/...-review/). A classification made
// on a short body from a review-marker URL is judging the extraction failure,
// not the article — skip the stamp and leave the file retriable.
function shouldSkipNonReviewStamp(d) {
  if (!d) return false;
  const text = (d.fullText || '').trim();
  return text.length < 800 && looksLikeReviewUrl(d.url);
}

// RC3 (The Upcoming, 2026-07-23): empty-body files whose outlets no aggregator
// cites never entered flaggedMisses, so the hourly self-heal never retried them
// — a 0-byte stub of a real published review sat inert until a human refetched
// it (the first retry succeeded immediately). This predicate admits a dir file
// into the UNCITED retry pool: same human/wrong-flag protections as
// isRecoverableFlaggedFile, plus the file must carry its own review-marker URL
// (keeps Facebook-post and announcement junk out of the pool). An isNonReview
// stamp only blocks retry when it was made on substantive text — a stamp on a
// short body is the RC2 failure mode and must not strand the file.
function isRecoverableUncitedStub(d, cap = FLAGGED_RECOVERY_CAP) {
  if (!d || !d.url) return false;
  if (d.humanReviewScore != null) return false;
  if (d.wrongProduction === true || d.wrongShow === true) return false;
  if (d.wrongProductionManualClear === true || d.wrongShowManualClear === true) return false;
  if (d.humanReviewedWrongProduction === false) return false;
  if (d.duplicateOf || d.duplicateTextOf) return false;
  if (d.isRoundupArticle === true) return false;
  if (d.isNonReview === true && !shouldSkipNonReviewStamp(d)) return false;
  // SERP retry state: a file the backfill deliberately abandoned must not
  // re-enter the retry pool via the wider uncited net (ship-check 2026-07-23).
  if (d.serpDiscoveryAbandoned === true) return false;
  if ((d.aggUrlRecoveryCount || 0) >= cap) return false;
  if (!isEmptyBodyFile(d)) return false;
  return looksLikeReviewUrl(d.url);
}

// Star-fallback source mapping (The Stage class, 2026-07-23): when a paywalled
// outlet's text can't be fetched but a WE reference roundup cites the outlet
// WITH a star rating, writing aggregatorStars makes the review scoreable via
// the rebuild's aggregator-star path — instead of retrying a paywall to the cap
// and going silent. scoreSource values are members of AGGREGATOR_SCORE_SOURCES
// (review-normalization.js) so score routing treats them as
// aggregator-interpreted, never outlet-published.
const STAR_SOURCE_BY_REFERENCE = {
  'theatre-reviews': 'theatre-reviews-star-rating',
  'westendtheatre': 'westendtheatre-star-rating',
  'lbo-roundup': 'lbo-star-rating',
  'thestage-archive': 'thestage-roundup-star-rating',
};

/**
 * Decide what the hourly recovery loop should do with the recoverable dir file
 * behind one flaggedMiss. Returns a tagged action so the caller logs a precise
 * reason for every skip (cap vs human-protected vs wrong-production vs
 * not-empty-body) instead of a silent no-op.
 *
 * @param {object} args
 * @param {object|null} args.file        - the existing dir file's parsed JSON
 * @param {string|null} [args.outletId]  - canonical outletId to re-ingest under
 *                                          (the existing file's outletId — keeps
 *                                          the merge on the SAME slug)
 * @param {string|null} [args.critic]    - existing file's criticName (forces the
 *                                          ingest slug to match → merge not sibling)
 * @param {string|null} [args.url]       - aggregator's current-production URL to fetch
 * @param {number} [args.cap]
 * @returns {{ action: 'recover'|'skip', reason: string, outletId?: string|null, critic?: string|null, url?: string|null }}
 */
function decideEmptyBodyRecovery({ file, outletId = null, critic = null, url = null, cap = FLAGGED_RECOVERY_CAP } = {}) {
  if (!file) return { action: 'skip', reason: 'no-file' };
  if (!url) return { action: 'skip', reason: 'no-aggregator-url' };
  if (file.humanReviewScore != null) return { action: 'skip', reason: 'human-protected' };
  if (file.wrongProduction === true || file.wrongShow === true) return { action: 'skip', reason: 'wrong-production-or-show' };
  if (file.wrongProductionManualClear === true || file.wrongShowManualClear === true) return { action: 'skip', reason: 'manual-clear' };
  if (file.humanReviewedWrongProduction === false) return { action: 'skip', reason: 'human-verified-production' };
  if ((file.aggUrlRecoveryCount || 0) >= cap) return { action: 'skip', reason: 'cap-reached' };
  if (!isEmptyBodyFile(file)) return { action: 'skip', reason: 'not-empty-body' };
  return { action: 'recover', reason: 'empty-body-merge-safe', outletId, critic, url };
}

// Next aggUrlRecoveryCount value. The loop writes this to the file after EVERY
// attempt (success or failure) so a permanently-dead URL stops after `cap` tries.
function nextRecoveryCount(file) {
  return ((file && file.aggUrlRecoveryCount) || 0) + 1;
}

// Post-fill production-window check (Tender/Sessions incident 2026-07-24): a
// DATELESS stub fails the pre-fetch prior-run guard open, gets refilled, and
// only THEN carries a publishDate. If that date is outside
// [opening - 30d, opening + 365d], the URL was a different production/show
// SERP-mismatched onto this entry — the fill must be flagged, not published
// (validate-data.js goes red on main otherwise). The -30d start mirrors
// gap-ingest-policy's articleRunIdentity; the +365d end is deliberately wider
// than that policy's +90d (roundup-article identity) because an individual
// review of a long-running show can legitimately publish months after opening.
function filledDateOutsideWindow(publishDate, openingDate) {
  if (!publishDate || !openingDate) return false;
  const pd = new Date(publishDate).getTime();
  const op = new Date(openingDate).getTime();
  if (Number.isNaN(pd) || Number.isNaN(op)) return false;
  return pd < op - 30 * 86400000 || pd > op + 365 * 86400000;
}

module.exports = {
  FLAGGED_RECOVERY_CAP,
  filledDateOutsideWindow,
  isEmptyBodyFile,
  isRecoverableFlaggedFile,
  isRecoverableUncitedStub,
  looksLikeReviewUrl,
  shouldSkipNonReviewStamp,
  STAR_SOURCE_BY_REFERENCE,
  decideEmptyBodyRecovery,
  nextRecoveryCount,
};
