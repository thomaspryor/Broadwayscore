'use strict';

/**
 * duplicate-of-gate.js — pure block/pass decision for
 * `audit-duplicate-of-url-mismatch.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * 40k-file corpus scan. The split exists because review-texts live in a separate
 * private repo that data bots mutate every ~2min: the plain audit (block on ANY
 * mismatch) therefore reddened the trunk for every unrelated code push whenever a
 * single stale duplicateOf pointer existed in the window before its self-heal
 * (clear-stale-duplicate-of.yml --fix + rebuild) cleared it (the 4-BWW
 * sinatra-the-musical-west-end-2026 case, run 28388064370, 2026-06-28).
 *
 * EVERY mismatch this audit reports is auto-healable: clear-stale-duplicate-of.yml
 * runs `--fix`, which nulls the stale duplicateOf and re-admits the review at the
 * next rebuild. So single-file drift must NOT block the trunk — it heals on its own.
 * The genuine CATASTROPHE is a mass SPIKE: the same surge that makes `--fix` itself
 * refuse to auto-clear (FIX_SURGE_THRESHOLD) signals a producer regression
 * (review-write-guard writing bad pointers, a mass sibling rename) where blindly
 * re-admitting that many reviews would flood scoring with double-counted reviews.
 * Above the floor we WANT the trunk red so a human investigates before the
 * self-heal does damage. Same philosophy as contamination-gate / audit-text-quality --gate.
 *
 * The full audit (block on ANY mismatch) runs daily in check-corpus-drift.yml,
 * surfaced non-blocking in the digest — the net for sub-floor stale flags.
 *
 * @param {{mismatchCount:number, floor:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockDuplicateOfGate({ mismatchCount, floor }) {
  return mismatchCount > floor;
}

module.exports = { shouldBlockDuplicateOfGate };
