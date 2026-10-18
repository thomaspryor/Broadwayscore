/**
 * Canonical commercial designations — the single runtime list.
 * Mirrors the CommercialDesignation union in src/config/commercial.ts.
 *
 * LLM/RSS output arrives as "flop", "easy winner", etc. Writing those verbatim
 * broke the site's designation lookups and turned main's Test Suite red
 * (BRO-4570, titanique "flop"). commercial-write-guard.js canonicalizes every
 * record on save, and commercial-apply-gate.js drops unknown values on build.
 */

const VALID_DESIGNATIONS = [
  'Miracle', 'Windfall', 'Easy Winner', 'Trickle',
  'TBD', 'Fizzle', 'Did Not Recoup', 'Flop', 'Nonprofit', 'Tour Stop',
];

const keyOf = (s) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
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
 * analyst's range first, then an outside estimate; a range counts as its
 * midpoint. null when the record has neither.
 */
function ownReturnedEstimatePct(entry) {
  for (const v of [entry?.analystRecoupPct, entry?.estimatedRecoupmentPct]) {
    if (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) return (v[0] + v[1]) / 2;
    if (Number.isFinite(v)) return v;
  }
  return null;
}
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
  for (const v of [entry.modelReturnedExCreditPct, entry.modelRecoupmentPctV2, entry.modelRecoupmentPct]) {
    if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return v[1];
  }
  return null;
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
 * The loss label a % returned supports (returnedEstimatePct): Fizzle at
 * FIZZLE_MIN_RETURNED_PCT or more, Flop under it, Did Not Recoup when there
 * is no estimate.
 */
function lossDesignationFor(returnedPct) {
  if (returnedPct == null) return 'Did Not Recoup';
  return returnedPct >= FIZZLE_MIN_RETURNED_PCT ? 'Fizzle' : 'Flop';
}
/** Classes the recoupment rule never moves. */
const DESIGNATIONS_OUTSIDE_RULE = Object.freeze(['Easy Winner', 'Nonprofit', 'Tour Stop']);

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
// designationBasis (owner policy B, BRO-5020 2026-10-11): what a loss label
// rests on. Writers stamp it; only the display layer turns
// 'no-recoupment-announced' into public words ("Based on no recoupment being
// announced"). A label on silence waits LOSS_LABEL_MIN_DAYS after closing,
// because some shows recoup after they close.
// ---------------------------------------------------------------------------
const DESIGNATION_BASES = Object.freeze({
  /** A cited source or the producers state the loss / non-recoupment. */
  REPORTED_LOSS: 'reported-loss',
  /** Inference from silence: closed, researched, no recoupment ever announced. */
  NO_RECOUPMENT_ANNOUNCED: 'no-recoupment-announced',
  /** Our notes describe a loss but the cite is not a hard source. */
  NOTES_STATED: 'notes-stated',
});
const VALID_DESIGNATION_BASES = Object.freeze(Object.values(DESIGNATION_BASES));
const LOSS_LABEL_MIN_DAYS = 183;

/**
 * True for a loss label resting on silence whose show closed under
 * LOSS_LABEL_MIN_DAYS ago: the one copy of the policy B age rule that the
 * record checks and the public-record sanitizer share. `show` is the
 * shows.json record; an unknown closing date never counts as premature.
 */
function isPrematureSilenceLabel(entry, show, now = Date.now()) {
  if (!entry || !show || !isLossDesignation(entry.designation)) return false;
  if (entry.designationBasis !== DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED) return false;
  const closing = Date.parse(show.closingDate);
  return Number.isFinite(closing) && (now - closing) / 86400000 < LOSS_LABEL_MIN_DAYS;
}

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
  DESIGNATION_BASES, VALID_DESIGNATION_BASES, LOSS_LABEL_MIN_DAYS, isPrematureSilenceLabel,
  VALID_DESIGNATIONS, canonicalDesignation,
  TRICKLE_MAX_MULTIPLE, MIRACLE_MIN_YEARS, FIZZLE_MIN_RETURNED_PCT, ownReturnedEstimatePct, returnedEstimatePct, DESIGNATIONS_OUTSIDE_RULE,
  LOSS_DESIGNATIONS, isLossDesignation, lossDesignationFor,
  MODEL_CONTRADICTION, modelContradictsDesignation,
};
