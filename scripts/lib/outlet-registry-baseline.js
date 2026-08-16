/**
 * Baseline-diff logic for audit-outlet-registry.js (task #1666).
 *
 * Mirrors scripts/lib/broadway-category-predicate-baseline.js (task #1665) but
 * uses a plain Set, not a multiset/occurrence-count Map. The predicate script
 * needed a multiset because the SAME (file, snippet) text can legitimately
 * appear on multiple distinct lines within one file (e.g. 12 near-identical
 * hits in newsletter/generate.mjs) — a Set would let one baselined occurrence
 * excuse an unbounded number of current ones with that same text.
 *
 * That hazard doesn't apply here: audit-outlet-registry.js's
 * auditOutletRegistry() already dedupes findings.missingFromRegistry by
 * outletId via a `Map` (see `missingOutlets` in audit-outlet-registry.js)
 * before it's ever returned from a single scan — an outletId can appear at
 * most once per run. There is no per-key duplicate-collapse hazard for a
 * plain Set to hide behind.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

// baselineOutletIds: array of outletId strings as stored in the baseline
// JSON's `outletIds` array. Returns a Set for O(1) membership checks.
function baselineKeySet(baselineOutletIds) {
  return new Set(baselineOutletIds || []);
}

// missingOutlets: array of { outletId, ... } as produced by
// audit-outlet-registry.js's auditOutletRegistry() (findings.missingFromRegistry).
// baselineSet: Set from baselineKeySet(). Returns the subset of missingOutlets
// whose outletId is NOT in the baseline — i.e. newly-introduced gaps.
function computeNewViolators(missingOutlets, baselineSet) {
  return (missingOutlets || []).filter(m => !baselineSet.has(m.outletId));
}

module.exports = { baselineKeySet, computeNewViolators };
