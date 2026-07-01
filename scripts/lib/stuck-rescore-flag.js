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

module.exports = { isStuckRescoreFlag };
