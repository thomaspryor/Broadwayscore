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
 * that precedent: each hit's identity is (file, snippet).
 *
 * Ship-check (adversarial Codex pass, task #1665) found a plain Set collapses
 * DUPLICATE identical snippets in the same file down to one key —
 * fetch-aggregator-pages.ts:186/385 both baseline to the exact same
 * `(file, snippet)` string. A Set membership test would let a single
 * baselined occurrence excuse an UNLIMITED number of current hits with that
 * same text — fix one of the two real occurrences and add a brand-new,
 * unrelated third occurrence with identical text elsewhere in the same file,
 * and it silently reads as "still 2, both baselined." Multiset (count-per-key)
 * matching closes this: only as many occurrences of a given (file, snippet)
 * are excused as were actually baselined; anything beyond that count is new.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

function hitKey(file, snippet) {
  return `${file}::${snippet}`;
}

// baselineHits: array of { file, snippet } as stored in the baseline JSON's
// `hits` array. Returns a Map of hitKey() -> occurrence count, so duplicate
// (file, snippet) pairs are counted, not collapsed to a single membership bit.
function baselineKeySet(baselineHits) {
  const counts = new Map();
  for (const h of baselineHits || []) {
    const key = hitKey(h.file, h.snippet);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// violators: array of { file, hits: [{ line, snippet }, ...] } as produced by
// audit-broadway-category-predicate.js's scanRepo(). baselineCounts: Map from
// baselineKeySet(). Returns the same shape, filtered down to only hits beyond
// the baselined occurrence count for their (file, snippet) identity — files
// left with zero hits are dropped entirely. Consumes budget per key as it
// walks each file's hits in order, so with N baselined occurrences of a given
// text, exactly N current occurrences of that same text are excused and any
// beyond that are new — a duplicate can't excuse an unbounded number of hits.
function computeNewViolators(violators, baselineCounts) {
  const remaining = new Map(baselineCounts);
  return violators
    .map(v => {
      const newHits = v.hits.filter(h => {
        const key = hitKey(v.file, h.snippet);
        const budget = remaining.get(key) || 0;
        if (budget > 0) {
          remaining.set(key, budget - 1);
          return false;
        }
        return true;
      });
      return newHits.length ? { file: v.file, hits: newHits } : null;
    })
    .filter(Boolean);
}

module.exports = { hitKey, baselineKeySet, computeNewViolators };
