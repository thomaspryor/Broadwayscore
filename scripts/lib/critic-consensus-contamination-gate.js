'use strict';

/**
 * critic-consensus-contamination-gate.js — pure block/pass decision for
 * `audit-critic-consensus-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * data/critic-consensus.json scan, matching contamination-gate / non-review-gate.
 *
 * critic-consensus summaries are generated against OUR reviews.json, so wrong-
 * SOURCE contamination is low risk. Of the audit's three FAIL signals only one is
 * a genuine per-push catastrophe:
 *   SHOW_NOT_IN_DB     (gate)  — a consensus key that resolves to no shows.json id;
 *                                a structural orphan, zero-FP, must not ship.
 *   REVIEWCOUNT_DRIFT  (drift) — |consensus.reviewCount − live count| >= 10
 *   MEANSCORE_DRIFT    (drift) — |consensus.meanScore − live mean| >= 15
 * The two drift signals are STALENESS, not contamination: they fire by design when
 * a new opening night surfaces 11+ reviews, and they SELF-HEAL the next time
 * update-critic-consensus.yml regenerates the summary. Hard-blocking them would
 * red the trunk precisely on opening nights — the worst possible time — for a
 * condition no code push caused. So they are demoted to the digest, not the gate.
 *
 * Floor 0 on the structural orphan class. The FULL audit (orphans + both drift
 * signals) runs daily and non-blocking via --strict in check-corpus-drift.yml,
 * surfaced in the digest, which is also where a stale consensus gets noticed and
 * regenerated.
 *
 * @param {{gateHits:number, floor?:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockCriticConsensusContaminationGate({ gateHits, floor = 0 }) {
  return gateHits > floor;
}

// The structural-orphan signal that gates the trunk (zero-FP). The drift signals
// (REVIEWCOUNT_DRIFT, MEANSCORE_DRIFT) are staleness that self-heals on regen —
// digest-only, never a per-push block.
const GATE_SIGNALS = new Set(['SHOW_NOT_IN_DB']);

module.exports = { shouldBlockCriticConsensusContaminationGate, GATE_SIGNALS };
