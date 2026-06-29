'use strict';

/**
 * review-texts-gate.js — pure block/pass decision for
 * `validate-review-texts.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * 40k-file corpus scan, matching contamination-gate / duplicate-of-gate.
 *
 * The default validator exits 1 on ANY error. Some error classes are genuine
 * integrity CATASTROPHES that no self-heal clears and that ship bad data to users;
 * others are auto-healable churn that the bot-mutated private review-texts repo
 * introduces continuously, reddening the trunk for unrelated pushes in the window
 * before the dedup/self-heal workflows clear them.
 *
 * CATASTROPHIC (zero-tolerance — always block):
 *   - json_parse:            corrupt JSON (e.g. a committed git conflict marker from
 *                            a bad enrich-reviews rebase, commit 09e78a7a). The
 *                            file is silently dropped from reviews.json. The
 *                            conflict-marker source is also blocked pre-push by
 *                            conflict-markers.js in push-with-retry.sh.
 *   - aggregator_contamination / aggregator_url_mismatch:
 *                            an aggregator's own rating stored as an outlet score,
 *                            or an aggregator URL attributed to a real outlet —
 *                            both surface a wrong score on a show page.
 *   - required_fields:       missing showId / outletId — structurally broken record.
 *   - broken_duplicate_ref:  duplicateOf/duplicateTextOf points at a file that does
 *                            not exist — a dangling pointer the rebuild can't follow.
 *
 * AUTO-HEALABLE (tolerate up to `floor`):
 *   - duplicate_review:      same outlet+critic+URL twice in a show dir. WE scrapers
 *                            mint timeout/unknown variant files between dedup passes;
 *                            audit-review-key-duplicates + dedup workflows clear them.
 *
 * The full validator (block on ANY error) runs daily in check-corpus-drift.yml,
 * surfaced non-blocking in the digest — the net for sub-floor duplicate churn.
 *
 * @param {{catastrophicErrors:number, healableErrors:number, floor:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockReviewTextsGate({ catastrophicErrors, healableErrors, floor }) {
  return catastrophicErrors > 0 || healableErrors > floor;
}

// Error `check` ids the validator emits, partitioned by gate class. Exported so the
// audit script and the test agree by construction (no drift between the two lists).
const CATASTROPHIC_CHECKS = new Set([
  'json_parse',
  'aggregator_contamination',
  'aggregator_url_mismatch',
  'required_fields',
  'broken_duplicate_ref',
]);

const HEALABLE_CHECKS = new Set([
  'duplicate_review',
]);

module.exports = { shouldBlockReviewTextsGate, CATASTROPHIC_CHECKS, HEALABLE_CHECKS };
