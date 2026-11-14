'use strict';

const { MIN_SCORED_REVIEWS, isConsensusEligible } = require('../critic-consensus-eligibility');

const name = 'critics-take-present';
const description = 'Composite score exists but Critics Take (critic-consensus.json) is missing or empty';

/**
 * Scored reviews as this check can see them: reviews.json entries, the same
 * source and the same exclusions t1-outlets-scored.check.js uses. Deliberately
 * NOT the review-text files the generator scans.
 *
 * This must stay a pure function of `reviews` — no filesystem reads. The
 * original reason was that data/review-texts/ did not exist in the checklist
 * job at all; BRO-234 (commit 4275723c6f0) added checkout-review-texts for the
 * 8 other checks that need it, so that is no longer true. The rule stands for a
 * better reason: a count that varies with which job happens to have the
 * directory mounted would make this check's verdict depend on CI plumbing
 * rather than on data. Locked by tests/unit/critic-consensus-eligibility.test.mjs.
 *
 * @param {Array<Object>} reviews - context.reviewsDoc[show.id]
 * @returns {number}
 */
function countScoredReviews(reviews) {
  return (reviews || []).filter(r => {
    if (r.wrongProduction === true || r.wrongShow === true) return false;
    return r.assignedScore != null || r.compositeScore != null;
  }).length;
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (show.compositeScore == null) {
    return { ok: true, severity: 'ok', message: 'No compositeScore yet — Critics Take not required' };
  }

  // A show can carry a composite off a single review, but
  // generate-critic-consensus.js refuses to write a consensus below
  // MIN_SCORED_REVIEWS. Flagging one of those shows produced an endless
  // detect -> dispatch -> generator-skips -> detect loop (task #389:
  // death-note-the-musical-west-end-2026, 5 dispatches + 23 escalations).
  // The threshold is imported, never re-typed, so lowering it in the generator
  // moves this check with it.
  const scoredCount = countScoredReviews(context.reviewsDoc[show.id]);
  if (!isConsensusEligible(scoredCount)) {
    return {
      ok: true,
      severity: 'ok',
      message: `Only ${scoredCount} scored review(s) — below the ${MIN_SCORED_REVIEWS} generate-critic-consensus.js requires, so no Critics Take is expected`,
    };
  }

  const entry = context.criticConsensusDoc[show.id];
  // critic-consensus.json uses 'text' field for the consensus blurb
  const hasText = entry && typeof entry.text === 'string' && entry.text.trim().length > 0;

  if (!hasText) {
    return {
      ok: false,
      severity: 'warning',
      message: `Composite score exists (${show.compositeScore}) but Critics Take is missing; run: node scripts/generate-critic-consensus.js --show=${show.id}`,
      details: {
        compositeScore: show.compositeScore,
        entry: entry || null,
        // Self-declared remediation (task #389). The checklist runner collects
        // details.remediation from every result — it does NOT switch on check
        // name — so a new check opts into auto-remediation by emitting this
        // field, exactly like details.missingReviews already works for the BWW
        // RR stub path (opening-night-checklist.js remediateMissingReviews).
        remediation: {
          kind: 'workflow',
          key: `critic-consensus:${show.id}`,
          workflow: 'update-critic-consensus.yml',
          inputs: { show: show.id, force: 'true' },
          reason: `composite ${show.compositeScore} with no Critics Take`,
        },
      },
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `Critics Take present for ${show.id} (score: ${show.compositeScore})`,
  };
}

module.exports = { name, description, run, countScoredReviews };
