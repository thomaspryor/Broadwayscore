/**
 * Last-line uniqueness guard for rebuild-all-reviews.js output (BRO-4809).
 *
 * The outlet-level dedup passes run BEFORE the manual-entry merge, and that
 * merge appends unchecked, so a row can still reach reviews.json twice (main
 * went red 2026-10-06: slam-frank-off-broadway-2026 / off-off-online / Marc
 * Miller, two byte-identical rows). This collapses rows that share the exact
 * ReviewsList key (scripts/lib/review-list-key.js) within a show — the same
 * invariant tests/unit/show-proof-rage-clicks.test.mjs enforces on the data —
 * keeping a manual / human-scored copy over a pipeline copy, else the first.
 *
 * Mutates nothing: returns { reviews, removed }.
 */
'use strict';
const { getReviewKey } = require('./review-list-key');

function preferenceRank(r) {
  return (r.manualEntry === true ? 2 : 0) + (r.humanReviewScore != null ? 1 : 0);
}

function dedupeByReviewKey(reviews) {
  const kept = new Map();
  for (const r of reviews) {
    const key = `${r.showId}|${getReviewKey(r)}`;
    const prev = kept.get(key);
    if (!prev) kept.set(key, r);
    else if (preferenceRank(r) > preferenceRank(prev)) kept.set(key, r);
  }
  // Map keeps first-insertion order, so output order is stable.
  const out = [...kept.values()];
  return { reviews: out, removed: reviews.length - out.length };
}

module.exports = { dedupeByReviewKey };
