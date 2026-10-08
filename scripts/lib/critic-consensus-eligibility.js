'use strict';

/**
 * critic-consensus-eligibility.js — the one place that says how many scored
 * reviews a show needs before a Critics' Take can exist.
 *
 * WHY THIS FILE EXISTS (task #389):
 * scripts/generate-critic-consensus.js refuses to write a consensus for a show
 * with fewer than 2 scored reviews — one review is not a consensus. That floor
 * used to be a bare `< 2` literal inside the generator, invisible to anything
 * else. The opening-night check that DEMANDS a Critics' Take
 * (scripts/lib/opening-night-checks/critics-take-present.check.js) did not know
 * about it, so for death-note-the-musical-west-end-2026 — composite 44 off a
 * single scored review — the check flagged a gap, self-declared a remediation
 * that dispatched update-critic-consensus.yml, the generator skipped the show
 * for being under the floor, and the check flagged the same gap an hour later.
 * data/audit/remediation-log.jsonl recorded 5 dispatches and 23 escalations of
 * key `critic-consensus:death-note-the-musical-west-end-2026` before anyone
 * noticed. A detector must never demand an outcome its own remediation target
 * is coded to refuse.
 *
 * WHY IT EXPORTS A NUMBER AND NOT A LOADER:
 * the obvious fix — move the generator's private loadReviewTexts() here so both
 * sides count identically — is wrong twice over. (a) It would be a second,
 * independently-maintained copy of the review exclusion predicate, the exact
 * shape memory/feedback_includability_predicates_must_be_canonical.md exists to
 * prevent. (b) the two sides do not have the same source to count from, so a
 * shared loader would still not make them agree — see the count-gap note on
 * isConsensusEligible below. So the shared thing is the THRESHOLD; each caller
 * counts from whatever source it actually has.
 *
 * HISTORICAL NOTE (corrected by BRO-234, commit 4275723c6f0): reason (b) used
 * to be stated as "opening-night-checklist.yml checks out core-data ONLY, so
 * data/review-texts/ is never present in that job". That stopped being true —
 * the workflow now runs checkout-review-texts, because 8 other checks under
 * scripts/lib/opening-night-checks/ read context.reviewTextsRoot and were blind
 * in CI without it. The conclusion is unchanged (this check counts reviews.json
 * entries, not files on disk) but the reason is now the count gap, not absence.
 * Do not re-derive "review-texts is absent in CI" from this file.
 */

/**
 * Minimum scored reviews before a Critics' Take is generated at all.
 * Enforced in generate-critic-consensus.js's per-show loop; mirrored (never
 * re-derived) by critics-take-present.check.js.
 */
const MIN_SCORED_REVIEWS = 2;

/**
 * @param {number} scoredReviewCount - how many scored reviews the caller sees.
 *   The generator counts review-text files it could actually read text out of;
 *   the opening-night check counts reviews.json entries. These are NOT equal in
 *   either direction, and measured against the live corpus on 2026-08-10 the
 *   gap is real both ways: 14 shows have >= 2 scored reviews.json entries but
 *   < 2 the generator would use (WE aggregator-star reviews scored with no
 *   readable text), and filtering those out by contentTier trades them for 15
 *   shows in the opposite direction. So this predicate makes the common case
 *   right — it is what stops the death-note-the-musical-west-end-2026 loop —
 *   but it is a mirror, not a proof. The guarantee that no remediation can run
 *   forever lives one layer up, in opening-night-remediation.js's lifetime
 *   attempt ceiling, which does not depend on any check getting this right.
 * @returns {boolean} true when a consensus is allowed to exist for that count.
 */
function isConsensusEligible(scoredReviewCount) {
  return Number.isFinite(scoredReviewCount) && scoredReviewCount >= MIN_SCORED_REVIEWS;
}

/**
 * Scored rows per show in reviews.json: what the site actually shows. The
 * generator's review-texts view skips fewer exclusions than the rebuild, so a
 * Critics' Take written from it outlived the reviews it summarised (BRO-4852:
 * Midnight kept a blurb about Ben Platt after its two wrong-show reviews were
 * dropped; 25 shows carried a blurb with fewer than 2 live reviews).
 * @param {{reviews?: object[]}|object[]} reviewsJson
 * @returns {Map<string, number>}
 */
function liveScoredCounts(reviewsJson) {
  const rows = Array.isArray(reviewsJson) ? reviewsJson : (reviewsJson && reviewsJson.reviews) || [];
  const counts = new Map();
  for (const r of rows) {
    // Same rule as critics-take-present.check.js's countScoredReviews.
    if (!r || !r.showId || r.wrongShow || r.wrongProduction) continue;
    if (r.assignedScore != null || r.compositeScore != null) counts.set(r.showId, (counts.get(r.showId) || 0) + 1);
  }
  return counts;
}

/**
 * Most stale entries one run may prune. 25 existed when this landed; a much
 * larger number means reviews.json is truncated or empty, not that hundreds of
 * shows lost their reviews, so the caller skips the prune instead.
 */
const MAX_STALE_PRUNE = 100;

/** Show ids holding a consensus while the site has too few live reviews for one. */
function staleConsensusIds(consensusShows, counts) {
  return Object.keys(consensusShows || {}).filter((id) => !isConsensusEligible(counts.get(id) || 0));
}

/**
 * `${showId}|${outletId}` for every live scored row: the outlets the site shows
 * per show. The generator only summarises review texts from these.
 */
function liveOutletKeys(reviewsJson) {
  const rows = Array.isArray(reviewsJson) ? reviewsJson : (reviewsJson && reviewsJson.reviews) || [];
  const keys = new Set();
  for (const r of rows) {
    if (!r || !r.showId || r.wrongShow || r.wrongProduction) continue;
    if (r.assignedScore != null || r.compositeScore != null) keys.add(`${r.showId}|${r.outletId}`);
  }
  return keys;
}

module.exports = { MIN_SCORED_REVIEWS, MAX_STALE_PRUNE, isConsensusEligible, liveScoredCounts, staleConsensusIds, liveOutletKeys };
