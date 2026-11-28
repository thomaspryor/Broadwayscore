/**
 * Baseline-diff logic for audit-cv-flag-contradiction.js (task #1673).
 *
 * Mirrors scripts/lib/critic-outlets-baseline.js (task #1668): a plain Set,
 * not a multiset/occurrence-count Map. audit-cv-flag-contradiction.js's main()
 * loop calls detectCvFlagContradiction(data) exactly once per review-text file
 * (one file -> at most one hit), and each file lives under exactly one
 * showId/file path — a single scan can push at most one hit per (showId,
 * file) pair. No duplicate-collapse hazard for a plain Set to hide behind.
 *
 * Identity is (showId, file) only — not the detected `flag` or `cvReasoning`.
 * `flag` can legitimately change between runs (e.g. a file re-flagged
 * wrongProduction -> isRoundupArticle by an unrelated classifier pass is
 * still the same underlying stale record surfacing the same signal, not a
 * new finding), and `cvReasoning` is free-text LLM output that can reword
 * run-to-run without the underlying contradiction changing. Baselining on
 * either would cause spurious "new violator" failures on unrelated commits.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

function hitKey(showId, file) {
  return `${showId}::${file}`;
}

// baselineEntries: array of { showId, file, ... } as stored in the baseline
// JSON's `hits` array. Returns a Set of hitKey() strings for O(1) membership checks.
function baselineKeySet(baselineEntries) {
  return new Set((baselineEntries || []).map(e => hitKey(e.showId, e.file)));
}

// hits: array of { showId, file, ... } as produced by
// audit-cv-flag-contradiction.js's main() scan. baselineSet: Set from
// baselineKeySet(). Returns the subset of hits whose (showId, file) identity
// is NOT in the baseline — i.e. newly-introduced flag-vs-CV contradictions.
function computeNewViolators(hits, baselineSet) {
  return (hits || []).filter(h => !baselineSet.has(hitKey(h.showId, h.file)));
}

module.exports = { hitKey, baselineKeySet, computeNewViolators };
