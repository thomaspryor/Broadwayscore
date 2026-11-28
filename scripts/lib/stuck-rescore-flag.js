'use strict';

/**
 * stuck-rescore-flag.js — the standing invariant behind the late-star bug class.
 *
 * A review flagged `needsRescore=true` is a PRODUCER queuing work for the scoring
 * CONSUMER (llm-scoring/index.ts --needs-rescore). The consumer filters to
 * `isScoreable` BEFORE processing (index.ts:817) and only clears needsRescore
 * AFTER scoring. So if a producer flags a review the consumer rejects, the flag
 * is NEVER cleared: it sits needsRescore=true forever and the queue accumulates
 * stuck entries on every cron.
 *
 * That is exactly what the late-star flagger did (2026-06-30): it used a
 * hand-rolled inclusion subset (wrongShow/wrongProduction/isRoundupArticle)
 * instead of the canonical predicate, so it flagged 5 reviews the scorer drops
 * (3 duplicateOf + 2 consent-wall stubs). Unit tests + actionlint + a green CI
 * run all passed — the bug lived in the SEAM between producer and consumer, which
 * no component test exercises.
 *
 * This predicate IS that seam, asserted as a corpus invariant:
 *   needsRescore === true  ⟹  isScoreable(review) === true
 * A violation is a stuck flag — always either a producer bug (like late-star) or a
 * review that became non-includable AFTER being queued (re-flagged wrongProduction,
 * duplicate discovered) and whose needsRescore should be cleared. Either way it is
 * real, actionable, and catches the WHOLE class for every current/future producer
 * of needsRescore — not just the one that bit us. Wired into the non-blocking
 * corpus-drift monitor (check-corpus-drift.js) so it runs daily + after each
 * rebuild with no one having to remember to check.
 *
 * Pure (no I/O) per project rule 15 — the caller reads the file + show title.
 * Uses the SAME isScoreable the consumer uses, by import, so it can never drift
 * from what the scorer actually accepts (memory/feedback_includability_predicates_must_be_canonical).
 */

const { isScoreable } = require('./is-scoreable');
const { isIncludableForRebuild } = require('./review-guards');

/**
 * @param {object} data - review-text record
 * @param {object} [show] - { title } for the show; forwarded to isScoreable so its
 *   wrongShow stale-flag override can activate. Falls back safely when omitted.
 * @param {string} [filePath] - review file path; forwarded to isScoreable for its
 *   path-based cross-show checks. Optional.
 * @returns {boolean} true iff the review is flagged for rescore but the scorer
 *   would reject it — i.e. a stuck flag that can never clear.
 */
function isStuckRescoreFlag(data, show, filePath) {
  if (!data || data.needsRescore !== true) return false;
  return !isScoreable(data, show, filePath);
}

/**
 * True when needsRescore is the ONLY thing keeping this review out of the
 * rebuild. A legacy web-search row whose score was read from the invented
 * excerpt is held out while its rescore is pending (review-guards.js
 * isUnverifiableWebSearchRow, BRO-5183); if the scorer cannot take it, the
 * flag looks stuck, and clearing it would publish the excerpt score
 * (BRO-5261 retro-review of BRO-5222). Such flags are reported, never auto-cleared.
 * @param {object} data - review-text record
 * @param {object} [show]
 * @param {string} [filePath]
 * @returns {boolean}
 */
function isRebuildHoldFlag(data, show, filePath) {
  if (!data || data.needsRescore !== true) return false;
  return !isIncludableForRebuild(data, show, filePath)
    && isIncludableForRebuild({ ...data, needsRescore: false }, show, filePath);
}

/**
 * The OTHER half of the same seam (2026-07-26). isStuckRescoreFlag covers
 * "queued but the consumer would reject it". This covers "queued but the
 * consumer already scored it successfully and failed to retire the flag" —
 * the Haiku-fallback success path in llm-scoring/index.ts saved a score and
 * returned before the needsRescore clear, so those files were re-scored by
 * every drain forever (bw-v6-decompression queue frozen at 141 for ~6 days,
 * 10 of them already scored).
 *
 * The producing bug is fixed at source (scripts/lib/rescore-lifecycle.js
 * markRescoreComplete, called by every success path, enforced by
 * tests/unit/rescore-lifecycle.test.mjs). This predicate is the corpus-side
 * backstop so a future regression shows up in the same audit as its sibling
 * instead of silently burning API spend.
 *
 * Pure (no I/O), same as its sibling.
 *
 * @param {object} data - review-text record
 * @returns {boolean} true iff flagged for rescore but a score is already present
 */
function isScoredButStillQueued(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.needsRescore !== true && data.needs_rescore !== true) return false;
  const scoredAt = (data.llmMetadata && data.llmMetadata.scoredAt) || data.scoredAt;
  if (!scoredAt) return false;

  // DO NOT broaden this to "has any score while queued". Most producers requeue
  // a review precisely BECAUSE it was already scored and something changed —
  // 'fullText added after excerpt-based scoring', 'fullText recovered from
  // Wayback Machine', 're-ensemble-v2-decluster'. Those are healthy pending
  // work, not stuck flags. A 2026-07-26 corpus scan measured the difference:
  // 192 files were "scored + queued", but only 30 were actually stuck. The
  // broad version would have handed the other 162 to this auditor's --fix,
  // which DELETES needsRescore (audit-stuck-rescore-flags.js:124) and would
  // have silently cancelled 162 genuinely-needed rescores.

  // Retired correctly by a post-fix run — not stuck.
  if (data.rescoreCompletedAt) return false;

  const flaggedAt = data.rescoreFlaggedAt || data.needsRescoreAt;

  // The original provable fingerprint (2026-07-26): the Haiku-fallback path is
  // the only writer of this scoreSource and the path that failed to retire the
  // flag. Those files never got a stamp, so an absent stamp counts as stuck.
  if (data.scoreSource === 'manual-cleared-haiku-fallback') {
    if (!flaggedAt) return true;
    return isAfter(scoredAt, flaggedAt);
  }

  // General path (BRO-117): every producer now stamps rescoreFlaggedAt at
  // enqueue (rescore-lifecycle.js markRescoreFlagged), so a score written AFTER
  // the flag was raised, with the flag still set, means the scorer served the
  // queue entry and failed to retire it, whatever the producer. A score older
  // than the stamp is a legitimate requeue (the 162 healthy files above).
  // No stamp (files queued before BRO-117, or a producer that skipped the
  // helper) stays presumed legitimate: without a timestamp it is
  // indistinguishable from a healthy requeue.
  if (!flaggedAt) return false;
  return isAfter(scoredAt, flaggedAt);
}

// Timestamps come from different writers (with/without millis, offsets), so
// compare as instants; fall back to string order only if either won't parse.
function isAfter(a, b) {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return String(a) > String(b);
}

module.exports = { isStuckRescoreFlag, isScoredButStillQueued, isRebuildHoldFlag };
