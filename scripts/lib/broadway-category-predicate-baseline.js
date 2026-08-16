/**
 * Baseline-diff logic for audit-broadway-category-predicate.js (task #1665).
 *
 * The sibling gate this mirrors (audit-direct-provider-calls.js /
 * direct-provider-detector.js) keys its baseline by file -> small provider
 * enum, because a file's violations there collapse into ~4 possible
 * categories. This detector has no such enum: every hit is an occurrence of
 * the SAME raw-literal pattern repeated per line (e.g. newsletter/generate.mjs
 * has 12 near-identical hits) — a per-file COUNT would silently miss a
 * same-day swap (one baselined hit hand-fixed, a different new one added:
 * count stays flat). That exact failure mode is why
 * audit-sibling-title-misroute.js (task #1608, one day earlier in this repo)
 * rejected a count ceiling for identity-based diffing instead — this follows
 * that precedent: each hit's identity is (file, snippet), diffed as a set.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

function hitKey(file, snippet) {
  return `${file}::${snippet}`;
}

// baselineHits: array of { file, snippet } as stored in the baseline JSON's
// `hits` array. Returns a Set of hitKey() strings for fast membership tests.
function baselineKeySet(baselineHits) {
  return new Set((baselineHits || []).map(h => hitKey(h.file, h.snippet)));
}

// violators: array of { file, hits: [{ line, snippet }, ...] } as produced by
// audit-broadway-category-predicate.js's scanRepo(). Returns the same shape,
// filtered down to only hits whose (file, snippet) identity isn't in
// baselineKeys — files left with zero hits are dropped entirely.
function computeNewViolators(violators, baselineKeys) {
  return violators
    .map(v => {
      const newHits = v.hits.filter(h => !baselineKeys.has(hitKey(v.file, h.snippet)));
      return newHits.length ? { file: v.file, hits: newHits } : null;
    })
    .filter(Boolean);
}

module.exports = { hitKey, baselineKeySet, computeNewViolators };
