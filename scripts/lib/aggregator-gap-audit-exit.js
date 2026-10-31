'use strict';

/**
 * Exit-code decision for scripts/audit-show-review-gap.js (BRO-3953).
 *
 * The workflow's "Run gap audit" step goes red ONLY through this decision. The
 * 2026-09 failure streak (3 of 5, then 9 of 16 runs) was never a per-aggregator
 * fetch failure: fetch errors are absorbed per-source and the audit carries on.
 * Every red run was the blast-radius guard refusing (or partially refusing) the
 * write and exiting 1. Extracted so that contract is pinned by a test instead of
 * living in an inline ternary.
 *
 * @param {object} o
 * @param {boolean} o.dryRun
 * @param {{ok: boolean}} o.blast        blastRadiusCheck result (ok=false => refused, full or partial)
 * @param {boolean} o.failOnGap          --fail-on-gap
 * @param {number}  o.runWithGap         shows with a gap in this run's results
 * @returns {{ exitCode: number, reason: string }}
 */
function auditExitDecision({ dryRun, blast, failOnGap, runWithGap }) {
  if (!dryRun && blast && !blast.ok) {
    return { exitCode: 1, reason: 'blast-radius-refused' };
  }
  if (failOnGap && runWithGap > 0) {
    return { exitCode: 1, reason: 'fail-on-gap' };
  }
  return { exitCode: 0, reason: 'ok' };
}

module.exports = { auditExitDecision };
