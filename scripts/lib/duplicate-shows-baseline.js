/**
 * Baseline-diff logic for audit-duplicate-shows.js (task #1675).
 *
 * Mirrors scripts/lib/outlet-registry-baseline.js (task #1666): a plain Set
 * is sufficient here, not a multiset/occurrence-count Map like
 * broadway-category-predicate-baseline.js needed. audit-duplicate-shows.js's
 * main title+year grouping loop visits each (i, j) show pair at most once
 * per run (nested loop over group members, i < j), and the title-fragment
 * pass (findTitleFragmentDupes) likewise visits each show pair at most once
 * — so a given (showId, showId) pair can appear at most once per scan. There
 * is no per-key duplicate-collapse hazard for a plain Set to hide behind.
 *
 * Identity is the unordered pair of show ids, not the cluster `key` (which
 * is a normalized-title+year string or a title-fragment venue string) and
 * not the `reason` — a cluster's title-grouping key can shift if a show's
 * title/venue is edited without the underlying pair being a "new" finding,
 * and a pair's reason can flip between runs (e.g. incomplete-stub becoming
 * shared-venue-token once a stub gets its venue backfilled) without it
 * becoming a genuinely new duplicate claim. Freezing on (a.id, b.id) is what
 * actually matters: the same two shows already adjudicated as "not a real
 * dupe" (or "known dupe, not yet merged") stay frozen regardless of which
 * detection branch or grouping key produced them this run.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

// Unordered-pair identity: sort so (a, b) and (b, a) collide to the same key.
function pairKey(aId, bId) {
  return [aId, bId].sort().join('|');
}

// baselinePairs: array of { a, b } show-id pairs as stored in the baseline
// JSON's `pairs` array. Returns a Set for O(1) membership checks.
function baselineKeySet(baselinePairs) {
  return new Set((baselinePairs || []).map((p) => pairKey(p.a, p.b)));
}

// clusters: array of { key, pairs: [{ a: {id, ...}, b: {id, ...}, reason }, ...] }
// as produced by audit-duplicate-shows.js's main(). baselineSet: Set from
// baselineKeySet(). Returns the same shape, filtered down to only pairs whose
// (a.id, b.id) identity is NOT in the baseline — clusters left with zero
// pairs are dropped entirely.
function computeNewViolators(clusters, baselineSet) {
  return (clusters || [])
    .map((c) => ({
      key: c.key,
      pairs: (c.pairs || []).filter((p) => !baselineSet.has(pairKey(p.a.id, p.b.id))),
    }))
    .filter((c) => c.pairs.length > 0);
}

module.exports = { pairKey, baselineKeySet, computeNewViolators };
