'use strict';

/**
 * progress-watch.js — detects LIVENESS failures: a metric that satisfies every
 * existence/safety check but has stopped moving. Complements the repo's
 * existing threshold/existence audits (check-corpus-drift.js et al), which
 * only ever assert "is X present / under threshold", never "is X advancing".
 * See Notion 3aa637c5-416f-8169 (task #597) for the 4 silent-stall incidents
 * this generalizes: a queue depth pinned for days, a launch counter stuck at
 * zero, a --help flag executing real work, a stale-but-"Running" liveness
 * check.
 *
 * Shape covered: a counter sampled once per cycle whose value must NOT stay
 * flat across N consecutive cycles — a queue depth that should fall, a
 * production count that should rise, a success count that should vary. All
 * three reduce to the same predicate: "the last N samples are identical is
 * broken, regardless of which direction the metric is supposed to move" —
 * with one exception: a `direction: 'down'` surface pinned at exactly 0 is
 * the GOAL, not a stall (a drained queue staying empty is success, not
 * evidence the drain stopped running). Caught by an adversarial ship-check
 * review (task #597, 2026-07-30) before this shipped — the first thing a
 * naive version of this primitive would have done is page forever on every
 * queue it successfully emptied.
 *
 * Deliberately NOT covered: "when did this arm last succeed at all" is a
 * different shape (elapsed time since one event, not a value trajectory
 * across periodic samples) and is already solved by
 * scripts/lib/digest-snapshots.js's fresh/stale/missing/invalid states — do
 * not reimplement that here.
 */

const DEFAULT_CYCLES = 3;
const DEFAULT_MAX_HISTORY = 30;

/**
 * Append one observation to a surface's history, capped to maxHistory.
 * Pure — returns a new array, never mutates the input.
 *
 * @param {Array<{value:*, ts:?string}>} history - prior observations, oldest first
 * @param {*} value - the value observed this cycle (numbers are the common case)
 * @param {{maxHistory?:number, ts?:string}} [opts]
 * @returns {Array<{value:*, ts:?string}>}
 */
function recordProgress(history, value, { maxHistory = DEFAULT_MAX_HISTORY, ts = null } = {}) {
  const prior = Array.isArray(history) ? history : [];
  const next = [...prior, { value, ts }];
  return next.length > maxHistory ? next.slice(next.length - maxHistory) : next;
}

/**
 * Whether a surface's most recent `cycles` observations are all identical —
 * i.e. it stopped advancing. Cold-start safe: fewer than `cycles` recorded
 * observations is "not enough history yet", never a false-positive stall.
 *
 * `direction: 'down'` pinned at value 0 is never a stall — a queue drained to
 * empty and staying empty is the surface working correctly, not evidence the
 * drain died. There is no equivalent terminal value for 'up' (no natural
 * ceiling) or 'any', so this exception applies only to 'down'.
 *
 * @param {Array<{value:*, ts:?string}>} history - observations, oldest first
 * @param {{cycles?:number, direction?:string}} [opts]
 * @returns {{stalled:boolean, reason:string}}
 */
function isStalled(history, { cycles = DEFAULT_CYCLES, direction = 'any' } = {}) {
  if (!Array.isArray(history) || history.length < cycles) {
    return { stalled: false, reason: 'insufficient-history' };
  }
  const window = history.slice(history.length - cycles);
  const allSame = window.every((o) => o.value === window[0].value);
  if (!allSame) return { stalled: false, reason: 'moving' };
  if (direction === 'down' && window[0].value === 0) {
    return { stalled: false, reason: 'drained-to-zero (goal reached, not a stall)' };
  }
  return { stalled: true, reason: `unchanged for ${cycles} consecutive cycles (value: ${window[0].value})` };
}

/**
 * Convenience: record this cycle's observation, then check for a stall.
 * `direction` ('up'|'down'|'nonzero'|'any') both feeds the zero-terminal
 * exception above and is carried through for callers building a human-facing
 * message.
 *
 * @param {Array<{value:*, ts:?string}>} history
 * @param {*} value
 * @param {{cycles?:number, maxHistory?:number, direction?:string, ts?:string}} [opts]
 * @returns {{history:Array, stalled:boolean, reason:string, direction:string, value:*}}
 */
function assertProgress(history, value, opts = {}) {
  const { cycles = DEFAULT_CYCLES, maxHistory = DEFAULT_MAX_HISTORY, direction = 'any', ts = null } = opts;
  const nextHistory = recordProgress(history, value, { maxHistory, ts });
  const { stalled, reason } = isStalled(nextHistory, { cycles, direction });
  return { history: nextHistory, stalled, reason, direction, value };
}

module.exports = { recordProgress, isStalled, assertProgress, DEFAULT_CYCLES, DEFAULT_MAX_HISTORY };
