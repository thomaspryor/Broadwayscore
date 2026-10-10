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
  'TBD', 'Fizzle', 'Flop', 'Nonprofit', 'Tour Stop',
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
  return (pct > c.FAILED_ABOVE_PCT && (designation === 'Fizzle' || designation === 'Flop'))
    || (pct < c.WINNER_BELOW_PCT && (designation === 'Windfall' || designation === 'Miracle' || designation === 'Easy Winner'))
    || (pct > c.TRICKLE_ABOVE_PCT && designation === 'Trickle');
}

module.exports = {
  VALID_DESIGNATIONS, canonicalDesignation,
  TRICKLE_MAX_MULTIPLE, MIRACLE_MIN_YEARS, FIZZLE_MIN_RETURNED_PCT, DESIGNATIONS_OUTSIDE_RULE,
  MODEL_CONTRADICTION, modelContradictsDesignation,
};
