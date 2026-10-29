'use strict';

// When may the recoupment model's "% returned" bar be shown, and what does
// it read? (BRO-4989, checker decision #5, 2026-10-10.) One rule for the
// shadow report (scripts/shadow-display-guard.js) and the site
// (src/lib/commercial-display.ts).
//
// Hidden when any of:
//   few-weeks       fewer than 12 weeks played: too early to mean anything
//                   (not for a closed show: its run is complete, BRO-5502)
//   out-of-bounds   central outside [-25, 150]: the model is off its rails
//                   (Schmigadoon -169)
//   estimates-disagree  two independent estimates disagree: the record holds
//                   an outside range (trade, producer or a Reddit analysis;
//                   anything but our own inference) and the model central is
//                   more than 25 points outside it (checker decision (c))
//   too-uncertain   the printed range (negatives shown as 0) is more than 60
//                   points wide: one printed number would overclaim (checker,
//                   2026-10-10; measured as printed since BRO-5502, so
//                   [-42, -3, 33] prints as 0-33, not as 75 points of doubt)
//   awaiting-truth  a running show, while RUNNING_MODEL_BAR_ENABLED is off, or
//                   any show whose type is not in RUNNING_MODEL_BAR_TYPES,
//                   running or closed (musicals: BRO-5073, BRO-5502)
//   past-100-unannounced  a running or closed show the model puts at 100% or more: the
//                   bar would read "100%+" (recouped) on a show that has not
//                   announced it (BRO-5073: Mean Girls read 144 half a year
//                   before it recouped). A shown range tops out at 99.
//   star-deal-unknown  a star-driven show with no sourced gross-participation
//                   deal (BRO-5029): the model would leave the star's share
//                   of the gross out, so no bar rather than a guessed premium.
//                   Only when the caller passes starDealUnknown (the model's
//                   opts.sourcedStarDeals output); off until the live switch.
//   estimated-recouped  the same, but the low end of the range is 100 or more:
//                   the card says "Estimated to have recouped, not yet
//                   announced" instead of a bar (owner decision, BRO-5073:
//                   estimates are the point; 3 wrong early calls in 28 replay
//                   checkpoints, all musicals; BRO-5872 moved the musical
//                   checkpoints down, timing MAE 13.9 -> 11.5).
// Otherwise shown. An investor cannot get back less than nothing, so a
// negative value displays as 0 with "losing money so far"; the negative
// number stays internal.

const { runWindow } = require('./run-window');
const { ourRecoupRangePct } = require('./our-recoup-estimate');
const { FIZZLE_MIN_RETURNED_PCT, TRICKLE_MAX_MULTIPLE, WAIT_AND_SEE_MIN_RETURNED_PCT, hasNoInvestorsToRepay } = require('./commercial-designations');
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
// Owner turned it on for plays, 2026-10-11 (BRO-5073 timing test; strict
// backtest passes). Still inside the held Commercial Scorecard build.
const RUNNING_MODEL_BAR_ENABLED = true;
// Show types that get the model bar once the flag is on. Plays since
// 2026-10-11 (BRO-5073). Musicals since BRO-5872: they were held because the
// model ran about 2x high on them (BRO-5502: Hell's Kitchen 91 vs a reported
// 55-60, Death Becomes Her 45 vs a reported total loss). The cause was the
// flat ~11% gross-linked deduction on costs that leave royalties out; with
// the band on every reported musical cost (MUSICAL_LIVE_OPTS) closed-musical
// finals with a reported outcome read MAE 14.3 -> 5.8 as displayed (largest
// miss 47 -> 17, every reported figure inside the printed range), timing
// musicals 13.9 -> 11.5 (plays 13.2), 0 new false or early recouped. An
// analyst's figure still leads where there is one (displaysAnalyst).
// A null type counts as a musical; 'special' and 'opera' stay held.
const RUNNING_MODEL_BAR_TYPES = ['play', 'musical'];
// Notes stand in for a source only when they state a figure for the money
// returned or lost ("$6M loss (~40% of cap)"); notes without one ("No trade
// report of the capitalization") are no estimate (checker (c), 2026-10-10).

/**
 * The analyst's figure as a [low, high] range, or null when the record has none or it
 * is malformed (BRO-5502). Falls back to ourEstimateRangePct (our own rounded range).
 * @returns {[number, number] | null}
 */
function analystRange(comm) {
  const owner = ourRecoupRangePct(comm);
  if (owner) return owner;
  // Our own static range (ourEstimateRangePct) stands in when no analyst figure exists.
  const p = comm && (comm.analystRecoupPct || comm.ourEstimateRangePct);
  if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  return /** @type {[number, number]} */ ([Math.min(...p), Math.max(...p)]);
}

/**
 * Can an estimate sit next to a closed show's final designation without
 * contradicting it (BRO-5502)? Its middle must fall in the label's band:
 * Flop under FIZZLE_MIN_RETURNED_PCT returned, Fizzle from there to under
 * 100. Back to the Future read "Flop" next to a model 86% (BRO-4623): that
 * stays hidden. "Nonprofit" names how a show was funded, not how it ended, so
 * an estimate cannot contradict it (only an enhancement deal gets this far,
 * hasNoInvestorsToRepay). Any other final designation takes no estimate.
 * @param {number[]} range [low, high] or [low, central, high]
 */
function estimateFitsDesignation(range, designation, ownerEstimate = false) {
  if (!Array.isArray(range) || range.length < 2) return false;
  if (designation === 'Nonprofit') return true;
  const mid = range.length === 3 ? range[1] : (range[0] + range[1]) / 2;
  if (ownerEstimate && designation === 'Trickle') return mid >= 100 && mid < TRICKLE_MAX_MULTIPLE * 100;
  if (ownerEstimate && designation === 'Windfall') return mid >= TRICKLE_MAX_MULTIPLE * 100;
  if (designation === 'Flop') return mid < FIZZLE_MIN_RETURNED_PCT;
  if (designation === 'Wait & See') return mid >= WAIT_AND_SEE_MIN_RETURNED_PCT && mid < 100;
  if (designation === 'Fizzle') return mid >= FIZZLE_MIN_RETURNED_PCT && mid < 100;
  return false;
}

/** A closed show with a settled (non-TBD) designation. */
function isFinalClosed(comm, show) {
  return !!show && show.status === 'closed' && !!comm.designation && comm.designation !== 'TBD';
}

/**
 * Does the site show the analyst's figure for this record today? Mirrors
 * getRecoupmentDisplayMode(...) === 'analyst' in src/lib/commercial-display.ts.
 * The analyst's figure leads wherever there is one (they cover musicals, where it
 * was checked against outcomes; BRO-5502); a closed show's final designation must
 * not contradict it.
 */
function displaysAnalyst(comm, show) {
  if (!comm || !show) return false;
  if (comm.recouped === true || hasNoInvestorsToRepay(comm)) return false;
  const range = analystRange(comm);
  if (!range) return false;
  return !isFinalClosed(comm, show) || estimateFitsDesignation(range, comm.designation, !!ourRecoupRangePct(comm));
}

/**
 * Does the site show the model bar for this record today? Mirrors
 * getRecoupmentDisplayMode(...) === 'model' in src/lib/commercial-display.ts
 * (a unit test pins the two together). `comm` is the guarded record
 * (applyModelDisplayGuard), so a held model is already null here.
 */
function displaysModel(comm, show) {
  if (!comm || !show) return false;
  if (comm.recouped === true) return false;
  if (hasNoInvestorsToRepay(comm)) return false;
  if (displaysAnalyst(comm, show)) return false;
  if (!comm.modelRecoupmentPct) return false;
  if (comm.modelDataQuality === 'low' || comm.modelMethod === 'ai-estimated') return false;
  // Closed TBD shows the final estimate; a closed Fizzle/Flop only when the
  // estimate agrees with it (BRO-5502, replacing BRO-5020's blanket hide).
  return !isFinalClosed(comm, show) || estimateFitsDesignation(comm.modelRecoupmentPct, comm.designation);
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
 * `closed` (BRO-5502): the run is over, so few-weeks does not apply, while the
 * type rule and the past-100 holds do. Callers that know neither (running and
 * closed both false) keep the original behaviour.
 * @param {{ pct: [number, number, number] | null | undefined, playedWeeks: number, independent?: [number, number] | null, running?: boolean, closed?: boolean, runningEnabled?: boolean, showType?: string | null, runningTypes?: string[], starDealUnknown?: boolean }} input
 * @returns {{ show: boolean, reason: null | 'no-model' | 'star-deal-unknown' | 'few-weeks' | 'out-of-bounds' | 'estimates-disagree' | 'too-uncertain' | 'awaiting-truth' | 'past-100-unannounced' | 'estimated-recouped', shown: [number, number, number] | null, belowCosts: boolean }}
 */
function modelDisplayGuard({ pct, playedWeeks: weeks, independent = null, running = false, closed = false, runningEnabled = RUNNING_MODEL_BAR_ENABLED, showType, runningTypes = RUNNING_MODEL_BAR_TYPES, starDealUnknown = false }) {
  const hide = (reason) => ({ show: false, reason, shown: null, belowCosts: false });
  if (!Array.isArray(pct) || pct.length !== 3 || !pct.every((v) => typeof v === 'number' && Number.isFinite(v))) return hide('no-model');
  const central = pct[1];
  if (!closed && !(weeks >= MIN_PLAYED_WEEKS)) return hide('few-weeks');
  // After few-weeks, so a new show still reads "Too early" (BRO-5029).
  if (starDealUnknown) return hide('star-deal-unknown');
  if (central < CENTRAL_MIN || central > CENTRAL_MAX) return hide('out-of-bounds');
  if (independent) {
    const off = central < independent[0] ? independent[0] - central : central > independent[1] ? central - independent[1] : 0;
    if (off > MAX_DISAGREEMENT) return hide('estimates-disagree');
  }
  // Width as printed: an investor cannot get back less than nothing (BRO-5502).
  if (Math.max(0, pct[2]) - Math.max(0, pct[0]) > MAX_RANGE_WIDTH) return hide('too-uncertain');
  // showType undefined (callers that predate the per-type switch) keeps the flag alone.
  const typeHeld = showType !== undefined && !runningTypes.includes(showType || 'musical');
  if (running && (!runningEnabled || typeHeld)) return hide('awaiting-truth');
  if (closed && typeHeld) return hide('awaiting-truth');
  if ((running || closed) && central >= 100) return hide(pct[0] >= 100 ? 'estimated-recouped' : 'past-100-unannounced');
  // An unrecouped show never prints "100%+" (BRO-5073), closed ones included (BRO-5502: Our Town, a Fizzle, read 56%-100%+).
  const top = running || closed ? RUNNING_SHOWN_MAX : Infinity;
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
    // A run written before modelTaxCreditCounted existed: basis unknown, not pre-credit.
    const creditBasis = typeof creditCounted !== 'number' ? null : creditCounted > 0 ? 'post-credit' : 'pre-credit';
    return { pct: exCreditPct, creditBasis };
  }
  return { pct, creditBasis: null };
}

module.exports = {
  displayBasis, analystRange, estimateFitsDesignation, displaysAnalyst,
  modelDisplayGuard, displaysModel, playedWeeks, independentEstimate, isRunning, RUNNING_MODEL_BAR_ENABLED, RUNNING_MODEL_BAR_TYPES,
  MIN_PLAYED_WEEKS, CENTRAL_MIN, CENTRAL_MAX, MAX_DISAGREEMENT, MAX_RANGE_WIDTH, RUNNING_SHOWN_MAX,
};
