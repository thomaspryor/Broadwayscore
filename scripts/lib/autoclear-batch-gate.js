/**
 * Auto-clear batch gate (Sprint 3 S3-T5, sprint-plan-t1-retrieval.md).
 *
 * Auto-clearing stale flags un-suppresses reviews, which MOVES LIVE SCORES.
 * Before a batch of auto-clears is applied, TWO independent gates must BOTH
 * pass, or the batch aborts:
 *
 *  1. SHADOW gate — the S3-T4 shadow report must say the evidence is clean
 *     (≥3 live would-clear candidates observed over ≥48h, all human-agreed, 0
 *     disagreements) AND both replay cases classified correctly. That is the
 *     report's `autoClearEnableAllowed` field.
 *  2. SCORING-DELTA gate — running the batch through scoring-delta.js must show
 *     NO T1 flip and ≤ the total-flip threshold, exactly the bar CLAUDE.md §12.7
 *     enforces for every review-guards-adjacent change.
 *
 * As of S3-T4 the shadow evidence is INSUFFICIENT (0 live candidates in a clean
 * corpus), so gate 1 fails and auto-clear STAYS OFF — the plan's explicitly
 * allowed "keep escalate-only" conclusion. This module is the mechanism that
 * will let auto-clear turn on ONLY when both gates genuinely pass.
 *
 * Pure — no I/O. The CLI (autoclear-stale-flags.js) supplies the shadow report
 * and the parsed scoring-delta result; the unit test drives it directly.
 */

'use strict';

// Mirror scoring-delta.js's own thresholds so the gate agrees with the tool.
const DEFAULT_GATE_THRESHOLDS = {
  maxT1Flips: 0,     // any T1 flip aborts (scoring-delta T1_FLIP_THRESHOLD)
  maxTotalFlips: 5,  // >5 total flips aborts (scoring-delta TOTAL_FLIP_THRESHOLD)
};

/**
 * Decide whether an auto-clear batch may proceed.
 *
 * @param {object} p
 * @param {boolean} p.enableAllowed - shadow report's autoClearEnableAllowed
 * @param {{flips?: number, t1Flips?: number}|null} p.scoringDelta - parsed scoring-delta --json
 * @param {object} [p.thresholds]
 * @returns {{proceed: boolean, reason: string, checks: object}}
 */
function assessBatchClearGate({ enableAllowed, scoringDelta, thresholds = DEFAULT_GATE_THRESHOLDS }) {
  const checks = {
    shadowEnableAllowed: !!enableAllowed,
    scoringDeltaRan: !!scoringDelta,
    t1Flips: scoringDelta ? (scoringDelta.t1Flips || 0) : null,
    totalFlips: scoringDelta ? (scoringDelta.flips || 0) : null,
  };

  // Gate 1: shadow evidence. Fail closed — no clean evidence, no auto-clear.
  if (!enableAllowed) {
    return { proceed: false, reason: 'shadow-evidence-insufficient', checks };
  }
  // Gate 2: scoring-delta must have run and stayed within thresholds.
  if (!scoringDelta) {
    return { proceed: false, reason: 'scoring-delta-not-run', checks };
  }
  if ((scoringDelta.t1Flips || 0) > thresholds.maxT1Flips) {
    return { proceed: false, reason: 'scoring-delta-t1-flip', checks };
  }
  if ((scoringDelta.flips || 0) > thresholds.maxTotalFlips) {
    return { proceed: false, reason: 'scoring-delta-total-flips-exceeded', checks };
  }
  return { proceed: true, reason: 'both-gates-pass', checks };
}

module.exports = {
  DEFAULT_GATE_THRESHOLDS,
  assessBatchClearGate,
};
