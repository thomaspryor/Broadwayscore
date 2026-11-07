/**
 * linear-cancel-gate.js — require a reason before a move into a
 * `canceled`-type workflow state.
 *
 * WHY THIS EXISTS (BRO-3435, 2026-09-21). linear-done-gate.js refuses a
 * "merged deployed checked" claim without real PR-EVIDENCE — but that gate
 * only wires to the `completed` state type. A session refused a Done close
 * could move the SAME card to Canceled instead: same practical outcome (the
 * card leaves the open board), zero evidence ever checked, and
 * audit-done-evidence.js's nightly re-verification sweep only scans Done, so
 * a Canceled card is invisible to it too. That is the exact failure
 * linear-done-gate.js exists to stop, one keystroke sideways.
 *
 * SCOPE, DELIBERATELY NARROW (second-opinion review, 2026-09-21). The
 * background review that produced this file also asked whether the
 * data-repo evidence gap (a broadway-scorecard-data / broadway-review-texts
 * commit is "foreign" to linear-done-gate.js's ancestry check) needed a
 * companion cross-repo `gh api` resolver in the same change. It found no
 * measurement that any data-repo session has actually hit that wall —
 * `--force`/`LINEAR_DONE_GATE_DISABLED` usage is currently unlogged, so the
 * claim was unfalsifiable either way. Building a second external API surface
 * (new auth/rate-limit failure modes) on an unmeasured premise is the thing
 * to avoid; this file's OWN bypass-ledger addition (wired in linear-brain.js)
 * is what turns that "unmeasured" into a measured number next month. The
 * cross-repo resolver stays parked on BRO-3435 until that number says it's
 * needed.
 *
 * SHAPE deliberately mirrors linear-duplicate-gate.js: a pure function over
 * data the caller already has, returning {gated, allowed, verdict, reason}
 * so the CLI owns all I/O and exit codes. Gated on `targetStateType`, not the
 * literal state NAME, so a team rename of "Canceled" does not silently stop
 * gating (the same drift trap linear-done-gate.js:14 documents).
 *
 * Unlike the duplicate gate, there is no server-side precondition to mirror
 * here — Linear will happily cancel a card with no reason. This gate is
 * pure client-side policy, so LINEAR_CANCEL_GATE_DISABLED=1 exists for the
 * same reason LINEAR_DONE_GATE_DISABLED/LINEAR_DUPLICATE_GATE_DISABLED do:
 * a policy this codebase invented, not one Linear enforces, must always have
 * a visible off switch rather than becoming un-overridable automation glue.
 */

'use strict';

const CANCELED_STATE_TYPE = 'canceled';
const MIN_REASON_LENGTH = 20;

/**
 * @param {object} input
 * @param {string} input.targetStateType   `type` of the state being moved INTO.
 * @param {string} [input.cancelReason]    value of `--cancel-reason`, when passed.
 * @returns {{gated: boolean, allowed: boolean, verdict: string, reason: string}}
 */
function checkLinearCancelTransition({ targetStateType, cancelReason } = {}) {
  if (targetStateType !== CANCELED_STATE_TYPE) {
    return { gated: false, allowed: true, verdict: 'not-a-cancel-move', reason: '' };
  }

  // A valueless `--cancel-reason` parses to boolean true (parseArgs treats a
  // trailing flag that way, same shape --force and --duplicate-of already
  // guard against elsewhere in this file's siblings) — String(true) would
  // record the literal text "true" as the reason, which is worse than no
  // reason at all: it LOOKS like an explanation was given.
  const reason = typeof cancelReason === 'string' ? cancelReason.trim() : '';

  if (reason.length < MIN_REASON_LENGTH) {
    return {
      gated: true,
      allowed: false,
      verdict: 'no-cancel-reason',
      reason:
        `Pass --cancel-reason "<at least ${MIN_REASON_LENGTH} characters>" explaining why this card\n` +
        `is being canceled rather than closed as Done.\n\n` +
        `Why: a card refused a Done close by linear-done-gate.js can otherwise leave the open\n` +
        `board via Cancel with zero evidence ever checked and zero record of why — the exact\n` +
        `outcome that gate exists to prevent, one state transition sideways.`,
    };
  }

  return { gated: true, allowed: true, verdict: 'cancel-reason-recorded', reason };
}

module.exports = { CANCELED_STATE_TYPE, MIN_REASON_LENGTH, checkLinearCancelTransition };
