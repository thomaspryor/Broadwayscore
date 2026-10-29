/**
 * Canonical commercial designations — the single runtime list.
 * Mirrors the CommercialDesignation union in src/config/commercial.ts.
 *
 * LLM/RSS output arrives as "flop", "easy winner", etc. Writing those verbatim
 * broke the site's designation lookups and turned main's Test Suite red
 * (BRO-4570, titanique "flop"). commercial-write-guard.js canonicalizes every
 * record on save, and commercial-apply-gate.js drops unknown values on build.
 */

const { ourRecoupRangePct } = require('./our-recoup-estimate');

const VALID_DESIGNATIONS = [
  'Miracle', 'Windfall', 'Easy Winner', 'Trickle',
  'TBD', 'Fizzle', 'Did Not Recoup', 'Flop', 'Nonprofit', 'Tour Stop',
  'Squeaker', 'Wait & See',
];

const keyOf = (s) => s.trim().toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/[\s_-]+/g, ' ');
const DESIGNATION_BY_KEY = new Map(VALID_DESIGNATIONS.map(d => [keyOf(d), d]));

// Returns the canonical spelling, or undefined for anything not in the list.
function canonicalDesignation(value) {
  if (typeof value !== 'string') return undefined;
  return DESIGNATION_BY_KEY.get(keyOf(value));
}

// ---------------------------------------------------------------------------
// Designation thresholds (BRO-4989 C): the one definition. designation-rule.js,
// commercial-scope.js (LLM criteria), src/config/commercial.ts (descriptions),
// merge-model-recoupment.js and the shadow reports all read these.
// ---------------------------------------------------------------------------

/** Recouped, open-ended: returned under this multiple of capitalization = Trickle, at or above = Windfall. */
const TRICKLE_MAX_MULTIPLE = 1.5;
/** A Miracle is a decade-plus recouped run. */
const MIRACLE_MIN_YEARS = 10;
/** Closed without recouping: this % or more of capitalization returned = Fizzle, under it = Flop. */
const FIZZLE_MIN_RETURNED_PCT = 30;
/**
 * The % of capitalization the record's own estimate says came back: the
 * owner's figure first, then the analyst's range and an outside estimate.
 * A range counts as its midpoint; null when there is no estimate.
 */
function ownReturnedEstimatePct(entry) {
  const owner = ourRecoupRangePct(entry);
  if (owner) return (owner[0] + owner[1]) / 2;
  for (const v of [entry?.analystRecoupPct, entry?.estimatedRecoupmentPct, entry?.ourEstimateRangePct]) {
    if (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) return (v[0] + v[1]) / 2;
    if (Number.isFinite(v)) return v;
  }
  return null;
}
/**
 * The same estimate as ownReturnedEstimatePct, as a [low, high] % range (a
 * single figure is a point range); null when the record has none (BRO-6335).
 */
function ownReturnedRangePct(entry) {
  const owner = ourRecoupRangePct(entry);
  if (owner) return owner;
  for (const v of [entry?.analystRecoupPct, entry?.estimatedRecoupmentPct, entry?.ourEstimateRangePct]) {
    if (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
    if (Number.isFinite(v)) return [v, v];
  }
  return null;
}
/**
 * Wait & See (owner 2026-10-29, BRO-6499): closed without recouping, but this
 * % of capitalization or more has come back and later money (tour, licensing,
 * a sale or buyout) may still get it there. Boundary with Fizzle (30% to under
 * 100%): the two overlap on 50-99%, and the difference is documented later
 * money, which a figure cannot show. So Wait & See is never inferred: the
 * automatic sizing (lossDesignationFor, estimatedDesignationForClosed) keeps
 * choosing Fizzle or Flop, and Wait & See is a reviewed, cited label that
 * needs recouped:false and an own estimate at or above this line
 * (commercial-record-checks.js). It counts as NOT recouped and is not a loss
 * label (isLossDesignation stays false), so no loss phrase prints for it.
 */
const WAIT_AND_SEE_MIN_RETURNED_PCT = 50;
/** Model data qualities good enough to split Fizzle from Flop. */
const SPLIT_MODEL_QUALITIES = new Set(['medium', 'high']);
/**
 * The % returned that a Fizzle/Flop rests on: the record's own estimate, else
 * the middle of our model's returned-so-far figure when its inputs are decent.
 * null when neither: then no Fizzle or Flop is claimed (owner 2026-10-18,
 * BRO-5623: "We shouldn't default to a random claim"), and a closed show that
 * did not recoup is Did Not Recoup (lossDesignationFor, BRO-5636).
 */
function returnedEstimatePct(entry) {
  const own = ownReturnedEstimatePct(entry);
  if (own !== null) return own;
  if (!SPLIT_MODEL_QUALITIES.has(entry?.modelDataQuality)) return null;
  return modelMiddleReturnedPct(entry);
}
/**
 * The middle of our model's returned-so-far figure, at any data quality: the
 * ex-credit figure first, then V2, then the original. null with no reading.
 */
function modelMiddleReturnedPct(entry) {
  for (const v of [entry?.modelReturnedExCreditPct, entry?.modelRecoupmentPctV2, entry?.modelRecoupmentPct]) {
    if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return v[1];
  }
  return null;
}
/**
 * The designation our best estimate gives a CLOSED show (owner 2026-10-24,
 * BRO-6158): the record's own estimate, else the model's middle figure at any
 * data quality. Under FIZZLE_MIN_RETURNED_PCT returned is Flop, 30% to under
 * 100% Fizzle, 100% or more the recouped side by the same 1.5x split the rule
 * uses (Trickle under, Windfall at or above). Easy Winner and Miracle need a
 * reported recoupment, so an estimate never picks them. null with no estimate.
 */
function estimatedDesignationForClosed(entry) {
  const own = ownReturnedEstimatePct(entry);
  const pct = own !== null ? own : modelMiddleReturnedPct(entry);
  if (pct === null) return null;
  if (pct >= 100) return pct >= TRICKLE_MAX_MULTIPLE * 100 ? 'Windfall' : 'Trickle';
  return lossDesignationFor(pct);
}
/**
 * The % returned that sizes a label: for a model-estimate label the record's
 * own estimate else the model at any quality (that is what it rests on),
 * otherwise returnedEstimatePct.
 */
function labelSizingPct(entry) {
  if (entry?.designationBasis === 'model-estimate') {
    const own = ownReturnedEstimatePct(entry);
    return own !== null ? own : modelMiddleReturnedPct(entry);
  }
  return returnedEstimatePct(entry);
}
/**
 * Closed-without-recouping labels. Fizzle and Flop also say how much came
 * back; Did Not Recoup is the loss with no estimate of that (owner
 * 2026-10-18, BRO-5636). Compare loss labels with isLossDesignation, never
 * with literal Fizzle/Flop lists (tests/unit/loss-designations.test.mjs).
 */
const LOSS_DESIGNATIONS = Object.freeze(['Fizzle', 'Did Not Recoup', 'Flop']);
const LOSS_DESIGNATION_SET = new Set(LOSS_DESIGNATIONS);
function isLossDesignation(designation) {
  return LOSS_DESIGNATION_SET.has(designation);
}
/**
 * Labels that say the show closed without recouping: the loss labels plus Wait
 * and See (not a loss, never phrased as one). Season stats count all of them as
 * not recouped; loss wording stays on isLossDesignation.
 */
const WAIT_AND_SEE = 'Wait & See';
const UNRECOUPED_DESIGNATIONS = Object.freeze([...LOSS_DESIGNATIONS, WAIT_AND_SEE]);
function isUnrecoupedDesignation(designation) {
  return LOSS_DESIGNATION_SET.has(designation) || designation === WAIT_AND_SEE;
}
/**
 * A model's central returned % without the NY State tax credit it counted:
 * modelReturnedExCreditPct is post-credit when modelTaxCreditCounted is above
 * 0, so the credit's share of capitalization comes back out. null when the
 * record lacks the figures. A Squeaker needs this under 100 with the credit
 * in the recouped total; the model can only corroborate it, a source reports it.
 */
function modelPctWithoutCredit(entry) {
  const mid = modelMiddleReturnedPct(entry);
  const cap = entry?.capitalization;
  const credit = entry?.modelTaxCreditCounted;
  if (mid === null || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(credit)) return null;
  return mid - (credit / cap) * 100;
}
/**
 * The loss label a % returned supports (returnedEstimatePct): Fizzle at
 * FIZZLE_MIN_RETURNED_PCT or more, Flop under it, Did Not Recoup when there
 * is no estimate.
 */
function lossDesignationFor(returnedPct) {
  if (returnedPct == null) return 'Did Not Recoup';
  return returnedPct >= FIZZLE_MIN_RETURNED_PCT ? 'Fizzle' : 'Flop';
}
/**
 * Our best guess at how a show did where no source says (owner 2026-10-18 and
 * 2026-10-19, BRO-5647: "give people some indication of how it did which they
 * can't get anywhere else"), shown beside the label as a marked estimate,
 * never as the label. By the record's own estimate, else the model's middle
 * figure at any data quality. The musical model's display hold covers the %
 * bar, not this line.
 *  - Did Not Recoup: Fizzle or Flop.
 *  - Undisclosed (a closed TBD, so entry.status must be passed): Recouped at
 *    100% or more returned (none when the record says recouped:false), else
 *    Fizzle or Flop. A recouped:true record is announced, never guessed.
 * null for any other label, or with no estimate at all.
 */
function likelyOutcomeDesignation(entry) {
  const undisclosed = entry?.designation === 'TBD' && entry.status === 'closed' && entry.recouped !== true;
  if (entry?.designation !== 'Did Not Recoup' && !undisclosed) return null;
  const own = ownReturnedEstimatePct(entry);
  const pct = own !== null ? own : modelMiddleReturnedPct(entry);
  if (pct === null) return null;
  // recouped:false prints "Not Recouped", so never guess Recouped beside it.
  if (undisclosed && pct >= 100) return entry.recouped === false ? null : 'Recouped';
  return lossDesignationFor(pct);
}
/**
 * Whether our model is what sizes this record's loss label: a loss label, no
 * human lock, and no estimate of the record's own. Previews of a model change
 * use it to see which labels the change can move.
 */
function modelSizesLossLabel(entry) {
  return isLossDesignation(entry?.designation) && entry.humanReviewedDesignation !== true
    && ownReturnedEstimatePct(entry) === null;
}
/**
 * The loss label an unlocked record's recorded estimate supports, when it is
 * not the one it carries: Fizzle or Flop by returnedEstimatePct (its own
 * estimate, else our model's middle figure), Did Not Recoup with none. null
 * when the label fits, is locked by a person, or is not a loss label.
 */
function resizedLossLabel(entry) {
  if (!isLossDesignation(entry?.designation) || entry.humanReviewedDesignation === true) return null;
  const sized = lossDesignationFor(labelSizingPct(entry));
  // A model-estimate label whose figure crossed 100% is a recouped-side call, not a resize.
  if (entry.designationBasis === 'model-estimate' && labelSizingPct(entry) >= 100) return null;
  return sized === entry.designation ? null : sized;
}
/** More loss labels than this moving in one model run is a model change, not drift. */
const MODEL_LOSS_RESIZE_LIMIT = 3;
/**
 * The designation moves the model writer makes after a run. It is the daily
 * catch-all for label sizes as for model figures, so a label follows its
 * estimate whichever writer moved it: a model change that carries a closed
 * show across the 30% line (BRO-5643: jagged-little-pill stayed a Fizzle at
 * 27%), or an analyst post that does (scrape-boring-waltz-costs.js writes the
 * estimate, never the label). Model-estimate tiers also follow drift across
 * the 100% and 150% lines (BRO-6187), unless a reported outcome or human lock
 * takes precedence. Above `limit` moves none is applied and all are
 * held for review, like update-commercial-data.js's designation circuit breaker.
 * @param {Array<[string, object]>} entries [key, record] pairs the run covered
 * @returns {{ moves: Array<{ key: string, from: string, to: string }>, held: boolean }}
 */
function planModelLossResizes(entries, limit = MODEL_LOSS_RESIZE_LIMIT) {
  const moves = [];
  for (const [key, entry] of entries) {
    let to = resizedLossLabel(entry);
    if (entry?.designationBasis === 'model-estimate' && entry.humanReviewedDesignation !== true
      && (isLossDesignation(entry.designation) || entry.designation === 'Trickle' || entry.designation === 'Windfall')) {
      // A verified recoupment is settled by its source, not model drift.
      if (entry.recouped === true) continue;
      const estimated = estimatedDesignationForClosed(entry);
      // A source saying it did not recoup still wins over an optimistic model.
      if (estimated && (isLossDesignation(estimated) || entry.recouped !== false)) {
        to = estimated === entry.designation ? null : estimated;
      }
    }
    if (to) moves.push({ key, from: entry.designation, to });
  }
  return { moves, held: moves.length > limit };
}
/** Classes the recoupment rule never moves. */
const DESIGNATIONS_OUTSIDE_RULE = Object.freeze(['Easy Winner', 'Nonprofit', 'Tour Stop', 'Squeaker', 'Wait & See']);

/**
 * Labels that say the show recouped. Use these lists, never a hand-written
 * one: six hand lists had to be found by hand when a label was proposed
 * (BRO-6446; tests/unit/recouped-designations.test.mjs).
 */
const RECOUPED_DESIGNATIONS = Object.freeze(['Miracle', 'Windfall', 'Easy Winner', 'Trickle', 'Squeaker']);
/** Recouped labels that need a reported recoupment (recouped:true): never our estimate. */
const REPORTED_WIN_DESIGNATIONS = Object.freeze(['Miracle', 'Windfall', 'Easy Winner', 'Squeaker']);
/** Recouped labels that mean returned under TRICKLE_MAX_MULTIPLE: watched for crossing it. */
const MODEST_RETURN_DESIGNATIONS = Object.freeze(['Trickle']);

/**
 * Model central recoupment % that contradicts a designation (a review flag,
 * never a designation change): failed shows modeled far past recoupment,
 * winners modeled below zero, Trickles modeled at many times capitalization.
 */
const MODEL_CONTRADICTION = { FAILED_ABOVE_PCT: 150, WINNER_BELOW_PCT: 0, TRICKLE_ABOVE_PCT: 300 };

function modelContradictsDesignation(pct, designation) {
  const c = MODEL_CONTRADICTION;
  return (pct > c.FAILED_ABOVE_PCT && isLossDesignation(designation))
    || (pct < c.WINNER_BELOW_PCT && (designation === 'Windfall' || designation === 'Miracle' || designation === 'Easy Winner'))
    || (pct > c.TRICKLE_ABOVE_PCT && designation === 'Trickle');
}

// ---------------------------------------------------------------------------
// designationBasis: what a designation rests on. Writers stamp it; only the
// display layer turns it into public words. Owner decision 2026-10-24
// (BRO-6158, superseding policy B's 183-day wait): a closed show gets our
// best-estimate designation right away from the recoupment model or an
// analyst's % returned, stamped 'model-estimate' and shown as our estimate,
// and it is updated if a recoupment is announced later. TBD is for running
// shows only.
// ---------------------------------------------------------------------------
const DESIGNATION_BASES = Object.freeze({
  /** A cited source or the producers state the loss / non-recoupment. */
  REPORTED_LOSS: 'reported-loss',
  /** Inference from silence: closed, researched, no recoupment ever announced. */
  NO_RECOUPMENT_ANNOUNCED: 'no-recoupment-announced',
  /** Our notes describe a loss but the cite is not a hard source. */
  NOTES_STATED: 'notes-stated',
  /** Our estimate from the recoupment model or an analyst's % returned; no source reports the outcome. */
  MODEL_ESTIMATE: 'model-estimate',
});
const VALID_DESIGNATION_BASES = Object.freeze(Object.values(DESIGNATION_BASES));

/**
 * A record with no investors' money of its own to recoup: a tour stop (its
 * investors are repaid across the whole tour) or a nonprofit production with
 * no enhancement money. An enhancement deal raises commercial money, so it
 * counts as commercial everywhere: season totals, the % recouped column and
 * its estimates (BRO-5502; LCT's Ragtime). One rule for the stats tiles
 * (isExcludedFromSeasonStats) and the display (model-display-guard.js,
 * commercial-display.ts).
 */
function hasNoInvestorsToRepay(rec) {
  if (!rec) return false;
  if (rec.designation === 'Tour Stop') return true;
  return rec.designation === 'Nonprofit' && rec.productionType !== 'enhancement';
}

module.exports = {
  hasNoInvestorsToRepay,
  DESIGNATION_BASES, VALID_DESIGNATION_BASES,
  VALID_DESIGNATIONS, canonicalDesignation,
  TRICKLE_MAX_MULTIPLE, MIRACLE_MIN_YEARS, FIZZLE_MIN_RETURNED_PCT, ownReturnedEstimatePct, ownReturnedRangePct, returnedEstimatePct, DESIGNATIONS_OUTSIDE_RULE,
  WAIT_AND_SEE, WAIT_AND_SEE_MIN_RETURNED_PCT, UNRECOUPED_DESIGNATIONS, isUnrecoupedDesignation, modelPctWithoutCredit,
  LOSS_DESIGNATIONS, isLossDesignation, RECOUPED_DESIGNATIONS, REPORTED_WIN_DESIGNATIONS, MODEST_RETURN_DESIGNATIONS, lossDesignationFor, modelMiddleReturnedPct, likelyOutcomeDesignation,
  estimatedDesignationForClosed, labelSizingPct,
  modelSizesLossLabel, resizedLossLabel, MODEL_LOSS_RESIZE_LIMIT, planModelLossResizes,
  MODEL_CONTRADICTION, modelContradictsDesignation,
};
