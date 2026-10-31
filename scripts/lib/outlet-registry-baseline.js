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

// BRO-4401: test.yml runs --strict on every push, but a review file only
// gets its outlet registered (or staged, see outlet-auto-register.js) by the
// NEXT rebuild. A file that landed in review-texts after the last rebuild
// therefore reads as a "NEW outlet missing from registry" for up to one
// rebuild cycle (~30 min) through no fault of anyone — 2026-09-30 01:32:
// goodstoriespodcast / ourquadcities / crisesnotes, all first seen after the
// 00:10 rebuild reviews.json carried. Split those off: they are reported,
// not failed; once a rebuild has seen them they are either registered
// (domain), staged (known) or genuinely missing (fail).
//
// violators: { outletId, earliestSeenAt } rows from computeNewViolators().
// rebuiltAtMs: epoch ms of the rebuild that produced data/reviews.json
// (its _meta.lastUpdated), or null/NaN when unknown — then nothing is
// deferred, which is the old behaviour.
function partitionAwaitingRebuild(violators, rebuiltAtMs) {
  const awaitingRebuild = [];
  const actionable = [];
  const cutoff = Number.isFinite(rebuiltAtMs) ? rebuiltAtMs : null;
  for (const v of violators || []) {
    const seen = v && v.earliestSeenAt ? Date.parse(v.earliestSeenAt) : NaN;
    if (cutoff !== null && Number.isFinite(seen) && seen > cutoff) awaitingRebuild.push(v);
    else actionable.push(v);
  }
  return { awaitingRebuild, actionable };
}

module.exports = { baselineKeySet, computeNewViolators, partitionAwaitingRebuild };
