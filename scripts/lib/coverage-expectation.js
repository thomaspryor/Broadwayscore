'use strict';

/**
 * S4-T3/S4-T4 — NO_REVIEW_EXPECTED registry determinations, with decay + a
 * reactivation check.
 *
 * A registry determination ("this outlet does not cover theatre") is only
 * trustworthy for as long as someone actually re-checked it. Without a decay
 * window a stale 2024 determination silently suppresses a real 2027 gap
 * forever. DECAY_DAYS forces a re-probe: a determination older than 14 days
 * (or with no `coverageExpectationDecidedAt` at all) no longer suppresses the
 * cell — it falls back to normal GAP evaluation.
 *
 * Reactivation is the inverse failure: the registry says an outlet doesn't
 * review theatre, but a real scored review from that exact outlet just
 * landed for this show. That is always worth surfacing (the determination
 * needs a human update), independent of whether it has already decayed.
 */

const DECAY_DAYS = 14;

function hasStaticNoReviewClaim(outlets, outletId) {
  const o = outlets && outlets[outletId];
  return !!(o && (o.coverageExpectation === 'none' || o.reviewsTheater === false));
}

/**
 * Is a registry "no review expected" determination still active (not decayed)?
 * @param {object} outlets registry.outlets map
 * @param {string} outletId
 * @param {number} nowMs
 * @returns {boolean}
 */
function isNoReviewExpectedActive(outlets, outletId, nowMs) {
  if (!hasStaticNoReviewClaim(outlets, outletId)) return false;
  const o = outlets[outletId];
  const decidedAt = o.coverageExpectationDecidedAt;
  if (!decidedAt) return false; // no evidence timestamp — require a re-probe before it can suppress
  const decidedMs = Date.parse(decidedAt);
  if (!Number.isFinite(decidedMs)) return false;
  const ageDays = (nowMs - decidedMs) / 86400000;
  return ageDays <= DECAY_DAYS;
}

/**
 * Given the set of outlets with a SCORED review for a show, return the ones
 * whose registry entry claims they don't review theatre — a reactivation.
 * Fires regardless of decay: a static claim contradicted by a real review is
 * always worth a human look, decayed or not.
 * @param {object} outlets
 * @param {Iterable<string>} scoredOutletIds
 * @returns {string[]} reactivated outletIds
 */
function detectReactivation(outlets, scoredOutletIds) {
  const out = [];
  for (const outletId of scoredOutletIds) {
    if (hasStaticNoReviewClaim(outlets, outletId)) out.push(outletId);
  }
  return out;
}

module.exports = { isNoReviewExpectedActive, detectReactivation, hasStaticNoReviewClaim, DECAY_DAYS };
