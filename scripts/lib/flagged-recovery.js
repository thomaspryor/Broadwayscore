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

module.exports = {
  FLAGGED_RECOVERY_CAP,
  isEmptyBodyFile,
  isRecoverableFlaggedFile,
  decideEmptyBodyRecovery,
  nextRecoveryCount,
};
