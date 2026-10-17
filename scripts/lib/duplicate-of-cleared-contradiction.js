/**
 * Detects a review-text record carrying BOTH a live `duplicateOf` pointer AND
 * its own `_duplicateOfCleared` breadcrumb, where the pointer targets a
 * sibling that shares the exact same URL the breadcrumb was cleared for
 * (task #1655).
 *
 * WHY THIS EXISTS. `_duplicateOfCleared` is a legacy "this same-URL collision
 * is NOT a duplicate" breadcrumb (e.g. two distinct critics genuinely
 * publishing under one shared article URL). It has exactly one live reader —
 * review-write-guard.js's write-time URL-collision decision
 * (shouldMarkUrlCollisionDuplicate / shouldMarkPostCorrectionDuplicate) — and
 * it stops THAT ONE heuristic from re-marking a fresh collision as a
 * duplicate. It has ZERO writers left in the codebase (grep, 2026-08-19) and,
 * critically, it is NEVER consulted by rebuild-all-reviews.js's duplicateOf
 * exclusion logic, which decides live scoring inclusion purely from
 * `duplicateOf` + the sibling-cycle/inheritance checks. So when some OTHER
 * writer sets `duplicateOf` directly on a record that still carries an old
 * `_duplicateOfCleared` (all ~16 duplicateOf-setting scripts in this repo do
 * this — none of them check the breadcrumb, and several call safeWriteReview
 * with `force: true`, which skips the one write-time check that does), the
 * record ends up asserting two contradictory verdicts about the exact same
 * URL collision. Nothing then decides which one is current, and the outcome
 * — which record's exclusion actually happens at rebuild — has depended on
 * incidental file-read ordering rather than a rule (the-authenticator-
 * west-end-2026 case, 2026-08-15: both same-URL siblings landed in
 * reviews.json and validate-data.js's duplicate-URL check went red).
 *
 * Retracting the stale `_duplicateOfCleared` breadcrumb (see
 * retractDuplicateOfCleared below) changes NOTHING about which review is
 * included — `duplicateOf` already governs that outcome today, with or
 * without the breadcrumb. It only removes the self-contradictory metadata
 * that makes the state look unresolved. This is why, unlike the
 * self-contradictory-clears --fix (memory/feedback_audit_fix_remediation_
 * untrusted.md — that one DOES move contentTier/inclusion), retraction here
 * is provably inclusion-neutral and safe to apply in bulk.
 *
 * "Same URL" uses the identical normalization validate-data.js's own
 * duplicate-URL-within-same-show+outlet gate uses (lowercase, strip a
 * fragment, strip one trailing slash) — this detector exists specifically to
 * catch records that would otherwise surface as THAT exact gate's failure,
 * so the two must agree on what "same URL" means.
 *
 * Pure module: no fs, no process, no side effects.
 */

'use strict';

/**
 * Canonical truthiness for the `_duplicateOfCleared` breadcrumb. Corpus scan
 * (2026-08-19) shows it is written only as a non-empty string
 * ("auto:2026-04-12 different critics (...)"), but treat a bare `true` the
 * same way other CLEAR_BREADCRUMBS-style checks in this repo do
 * (hasClearBreadcrumbValue in flag-contradiction.js) for defense against a
 * future writer using the boolean shape.
 *
 * @param {*} v
 * @returns {boolean}
 */
function hasDuplicateOfClearedValue(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.trim() !== '';
  return false;
}

/**
 * Same URL-normalization validate-data.js's "duplicate URL within same
 * show+outlet" gate uses: lowercase, strip everything from a `#` onward,
 * strip exactly one trailing slash. Deliberately NOT the fuller
 * canonicalizeUrlForDedup (query-param sorting/tracking-param stripping) —
 * this detector's job is to predict/explain THAT gate's verdict, not to
 * apply a broader notion of URL identity.
 *
 * @param {*} url
 * @returns {string|null}
 */
function normalizeUrlForSameUrlCheck(url) {
  if (!url || typeof url !== 'string') return null;
  return url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
}

/**
 * @param {object} args
 * @param {object} args.review - parsed review-text record
 * @param {object|null} args.target - parsed record `review.duplicateOf` points
 *   at (same show directory), or null/undefined if unreadable/missing
 * @returns {{
 *   contradicted: boolean,
 *   duplicateOf: string|null,
 *   ownUrl: string|null,
 *   targetUrl: string|null
 * }}
 */
function detectDuplicateOfClearedContradiction({ review, target } = {}) {
  const none = { contradicted: false, duplicateOf: null, ownUrl: null, targetUrl: null };
  if (!review || typeof review !== 'object') return none;
  if (!hasDuplicateOfClearedValue(review._duplicateOfCleared)) return none;

  const dupOf = review.duplicateOf;
  if (!dupOf || typeof dupOf !== 'string' || !dupOf.endsWith('.json')) return none;

  if (!target || typeof target !== 'object') return none;

  const ownUrl = normalizeUrlForSameUrlCheck(review.url);
  const targetUrl = normalizeUrlForSameUrlCheck(target.url);
  if (!ownUrl || !targetUrl) return none;
  if (ownUrl !== targetUrl) return none;

  return { contradicted: true, duplicateOf: dupOf, ownUrl, targetUrl };
}

/**
 * Resolve a contradiction by retracting the stale `_duplicateOfCleared`
 * breadcrumb, leaving `duplicateOf` (the live, currently-authoritative
 * verdict — see module header) untouched. Mutates `file` in place; returns
 * true when a field was actually removed.
 *
 * `_duplicateOfCleared` is NOT in review-write-guard.js's PROTECTED_FIELDS,
 * so — unlike retractStaleClearBreadcrumb's targets in flag-contradiction.js
 * — no CLEAR_BREADCRUMBS entry is needed to make this deletion durable
 * against a future safeWriteReview merge-restore: once it's gone from the
 * on-disk file, there is nothing left for a later write to "restore" from.
 *
 * @param {object} file - parsed review-text JSON (mutated)
 * @param {object} contradiction - a detectDuplicateOfClearedContradiction() hit
 * @param {Date} [now]
 * @returns {boolean}
 */
function retractDuplicateOfCleared(file, contradiction, now = new Date()) {
  if (!file || !contradiction || !contradiction.contradicted) return false;
  if (!Object.prototype.hasOwnProperty.call(file, '_duplicateOfCleared')) return false;

  const priorValue = file._duplicateOfCleared;
  delete file._duplicateOfCleared;

  // Durable provenance, mirroring the clearBreadcrumbRetracted* stamp pattern
  // in flag-contradiction.js's retractStaleClearBreadcrumb — proof the removal
  // was deliberate, not data loss.
  file.duplicateOfClearedRetracted =
    `retracted stale _duplicateOfCleared (${JSON.stringify(priorValue)}): contradicted live duplicateOf=${contradiction.duplicateOf} pointing at the same URL (#1655)`;
  file.duplicateOfClearedRetractedAt = now.toISOString().split('T')[0];
  return true;
}

module.exports = {
  detectDuplicateOfClearedContradiction,
  retractDuplicateOfCleared,
  hasDuplicateOfClearedValue,
  normalizeUrlForSameUrlCheck,
};
