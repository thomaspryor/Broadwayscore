'use strict';

/**
 * contamination-gate.js — pure block/pass decision for
 * `audit-review-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * 39k-file corpus scan. The split exists because review-texts live in a separate
 * private repo that data bots mutate every ~2min: `--strict` (block on ANY
 * strict-class hit) therefore reddened the trunk for every unrelated code push
 * whenever a single pre-existing/parallel C/E/F file existed. `--gate` blocks only
 * on a genuine integrity CATASTROPHE:
 *   - a cross-market leak (class A: another show's reviews shown) — ZERO tolerance, or
 *   - a mass-contamination spike: strict-class total beyond `floor`.
 * Single-file C/E/F drift is surfaced in the log but does NOT block. Same philosophy
 * as audit-text-quality --gate and the check-corpus-drift.yml split.
 *
 * @param {{crossMarketLeaks:number, strictHits:number, floor:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockContaminationGate({ crossMarketLeaks, strictHits, floor }) {
  return crossMarketLeaks > 0 || strictHits > floor;
}

module.exports = { shouldBlockContaminationGate };
