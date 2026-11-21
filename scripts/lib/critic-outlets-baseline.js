/**
 * Baseline-diff logic for audit-critic-outlets.js (task #1668).
 *
 * Mirrors scripts/lib/outlet-registry-baseline.js (task #1666): a plain Set,
 * not a multiset/occurrence-count Map. The predicate script
 * (broadway-category-predicate-baseline.js, task #1665) needed a multiset
 * because the SAME (file, snippet) text can legitimately appear on multiple
 * distinct lines within one file. That hazard doesn't apply here:
 * audit-critic-outlets.js's buildRegistry() builds flaggedReviews by
 * iterating each critic's `reviews` array exactly once per run, and each
 * entry in that array corresponds to exactly one review file scanned by
 * scanReviewTexts() (one push per file, per critic). A single file is
 * processed under exactly one criticSlug, so the (showId, file) pair that
 * identifies a finding can appear at most once per run — no duplicate-
 * collapse hazard for a plain Set to hide behind.
 *
 * Identity is (showId, file) — the file alone already pins the finding to
 * one specific review; criticSlug/outlet are stored in the baseline entry
 * for human readability but aren't part of the key (if the same file were
 * later reattributed to a different critic/outlet, that's the same
 * underlying review record surfacing the same suspicious-share finding, not
 * a new one).
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

function flagKey(showId, file) {
  return `${showId}::${file}`;
}

// baselineEntries: array of { showId, file, ... } as stored in the baseline
// JSON's `flags` array. Returns a Set of flagKey() strings for O(1) membership checks.
function baselineKeySet(baselineEntries) {
  return new Set((baselineEntries || []).map(e => flagKey(e.showId, e.file)));
}

// flaggedReviews: array of { showId, file, ... } as produced by
// audit-critic-outlets.js's buildRegistry() (flaggedReviews). baselineSet:
// Set from baselineKeySet(). Returns the subset of flaggedReviews whose
// (showId, file) identity is NOT in the baseline — i.e. newly-introduced
// suspicious critic-outlet attributions.
function computeNewViolators(flaggedReviews, baselineSet) {
  return (flaggedReviews || []).filter(f => !baselineSet.has(flagKey(f.showId, f.file)));
}

module.exports = { flagKey, baselineKeySet, computeNewViolators };
