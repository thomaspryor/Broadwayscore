'use strict';

// When may the recoupment model's "% returned" bar be shown, and what does
// it read? (BRO-4989, checker decision #5, 2026-10-10.) One rule for the
// shadow report (scripts/shadow-display-guard.js) and the site
// (src/lib/commercial-display.ts).
//
// Hidden when any of:
//   few-weeks       fewer than 12 weeks played: too early to mean anything
//   out-of-bounds   central outside [-25, 150]: the model is off its rails
//                   (Schmigadoon -169)
//   estimates-disagree  two independent estimates disagree: the record holds
//                   an outside range (trade, producer or a Reddit analysis;
//                   anything but our own inference) and the model central is
//                   more than 25 points outside it (checker decision (c))
//   too-uncertain   the model range is more than 60 points wide: one printed
//                   number would overclaim (checker, 2026-10-10)
//   awaiting-truth  a running show, while RUNNING_MODEL_BAR_ENABLED is off
//   past-100-unannounced  a running show the model puts at 100% or more: the
//                   bar would read "100%+" (recouped) on a show that has not
//                   announced it (BRO-5073: Mean Girls read 144 half a year
//                   before it recouped). A shown range tops out at 99.
// Otherwise shown. An investor cannot get back less than nothing, so a
// negative value displays as 0 with "losing money so far"; the negative
// number stays internal.

const { runWindow } = require('./run-window');
// Our own "Inferred:"/"Estimated:" figures are not a report.
const { OWN_INFERENCE, STATED_PCT } = require('./recoupment-ground-truth');

const MIN_PLAYED_WEEKS = 12;
const CENTRAL_MIN = -25;
const CENTRAL_MAX = 150;
const MAX_DISAGREEMENT = 25;
const MAX_RANGE_WIDTH = 60;
// Highest value a running, unrecouped show may print (BRO-5073).
const RUNNING_SHOWN_MAX = 99;
// Launch rule (BRO-4989 checker, 2026-10-10): no running show prints a model
// "% returned" until the display backtest has at least 5 hard-truth
// displayable rows and passes (node scripts/backtest-recoupment-ground-truth.js
// --displayable-only --strict). Flip this only after that holds. Closed shows
// are unaffected.
const RUNNING_MODEL_BAR_ENABLED = false;
// Notes stand in for a source only when they state a figure for the money
// returned or lost ("$6M loss (~40% of cap)"); notes without one ("No trade
// report of the capitalization") are no estimate (checker (c), 2026-10-10).

/**
 * Does the site show the model bar for this record today? Mirrors
 * getRecoupmentDisplayMode(...) === 'model' in src/lib/commercial-display.ts
 * (a unit test pins the two together).
 */
function displaysModel(comm, show) {
  if (!comm || !show) return false;
  if (comm.recouped === true) return false;
  // Closed: a final designation is settled, and a TBD reads "Undisclosed" (BRO-5020).
  if (show.status === 'closed') return false;
  if (comm.designation === 'Nonprofit') return false;
  if (!comm.modelRecoupmentPct) return false;
  return comm.modelDataQuality !== 'low' && comm.modelMethod !== 'ai-estimated';
}

/** Still running today: not closed and no closing date already past. */
function isRunning(show, now = new Date()) {
  if (!show || show.status === 'closed') return false;
  return !(show.closingDate && new Date(show.closingDate) <= now);
}

/** Weeks played so far (previews included, COVID dark weeks excluded). */
function playedWeeks(show, now = new Date()) {
  if (!show || !(show.previewsStartDate || show.openingDate)) return 0;
  return Math.max(0, runWindow(show, { now, playedOnly: true }).totalRunWeeks);
}

/**
 * The independent estimate [lo, hi] the record holds (any outside source,
 * Reddit included), or null when there is none or it is our own inference.
 * @returns {[number, number] | null}
 */
function independentEstimate(comm) {
  const est = comm && comm.estimatedRecoupmentPct;
  const basis = comm && (comm.estimatedRecoupmentSource || (STATED_PCT.test(comm.notes || '') ? comm.notes : null));
  if (!Array.isArray(est) || est.length !== 2 || !est.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (!basis || OWN_INFERENCE.test(basis)) return null;
  return /** @type {[number, number]} */ ([Math.min(...est), Math.max(...est)]);
}

/**
 * @param {{ pct: [number, number, number] | null | undefined, playedWeeks: number, independent?: [number, number] | null, running?: boolean, runningEnabled?: boolean }} input
 * @returns {{ show: boolean, reason: null | 'no-model' | 'few-weeks' | 'out-of-bounds' | 'estimates-disagree' | 'too-uncertain' | 'awaiting-truth' | 'past-100-unannounced', shown: [number, number, number] | null, belowCosts: boolean }}
 */
function modelDisplayGuard({ pct, playedWeeks: weeks, independent = null, running = false, runningEnabled = RUNNING_MODEL_BAR_ENABLED }) {
  const hide = (reason) => ({ show: false, reason, shown: null, belowCosts: false });
  if (!Array.isArray(pct) || pct.length !== 3 || !pct.every((v) => typeof v === 'number' && Number.isFinite(v))) return hide('no-model');
  const central = pct[1];
  if (!(weeks >= MIN_PLAYED_WEEKS)) return hide('few-weeks');
  if (central < CENTRAL_MIN || central > CENTRAL_MAX) return hide('out-of-bounds');
  if (independent) {
    const off = central < independent[0] ? independent[0] - central : central > independent[1] ? central - independent[1] : 0;
    if (off > MAX_DISAGREEMENT) return hide('estimates-disagree');
  }
  if (pct[2] - pct[0] > MAX_RANGE_WIDTH) return hide('too-uncertain');
  if (running && !runningEnabled) return hide('awaiting-truth');
  if (running && central >= 100) return hide('past-100-unannounced');
  const top = running ? RUNNING_SHOWN_MAX : Infinity;
  return { show: true, reason: null, shown: pct.map((v) => Math.min(top, Math.max(0, v))), belowCosts: central < 0 };
}

/**
 * Which figure a running show's bar is judged and shown on, and its NY tax
 * credit basis (owner decision, BRO-5073): a running show shows the "%
 * returned so far" run (modelReturnedExCreditPct), which leaves the credit out
 * until a source says it was received. creditCounted is the credit inside that
 * figure ($, modelTaxCreditCounted): post-credit when above 0. While the
 * running bar is off nothing changes: the live figure, basis null.
 * @returns {{ pct: [number, number, number] | null | undefined, creditBasis: 'pre-credit'|'post-credit'|null }}
 */
function displayBasis({ pct, exCreditPct, creditCounted, running = false, runningEnabled = RUNNING_MODEL_BAR_ENABLED }) {
  if (running && runningEnabled && Array.isArray(exCreditPct) && exCreditPct.length === 3) {
    return { pct: exCreditPct, creditBasis: creditCounted > 0 ? 'post-credit' : 'pre-credit' };
  }
  return { pct, creditBasis: null };
}

module.exports = {
  displayBasis,
  modelDisplayGuard, displaysModel, playedWeeks, independentEstimate, isRunning, RUNNING_MODEL_BAR_ENABLED,
  MIN_PLAYED_WEEKS, CENTRAL_MIN, CENTRAL_MAX, MAX_DISAGREEMENT, MAX_RANGE_WIDTH, RUNNING_SHOWN_MAX,
};
