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

module.exports = { VALID_DESIGNATIONS, canonicalDesignation };
