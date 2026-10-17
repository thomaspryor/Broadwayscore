'use strict';

/**
 * commercial-contamination-gate.js — pure block/pass decision for
 * `audit-commercial-contamination.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * data/commercial.json scan, matching contamination-gate / non-review-gate.
 * data/commercial.json is rewritten by scripts/update-commercial-data.js (Reddit /
 * trade-press text → Claude Sonnet) on a weekly cron, so blocking on every hit
 * flaps the trunk for unrelated pushes whenever a stale row sits in the file.
 *
 * The per-push CATASTROPHE class is the FAIL severity — impossible or
 * self-contradictory commercial physics:
 *   WEEKLY_GT_CAP          weeklyRunningCost > capitalization (impossible)
 *   DESIG_RECOUPED_CONTRA  recouped:true with "Flop"/"Fizzle" (or false + "Miracle")
 *   CAP_OUTLIER            capitalization < $100k or > $100M
 *   WEEKLY_OUTLIER         weeklyRunningCost < $20k or > $2M
 * The first two are logical contradictions (zero-FP by construction); the outlier
 * bands were chosen with margin over the live range (cap $2.25M–$68M, weekly
 * $250k–$1.5M) and have zero baseline hits. Floor 0 — a single impossible record
 * is a shipped data error a user can screenshot.
 *
 * The WARN severity (CATEGORY_TYPE_MISMATCH, SHOW_NOT_IN_DB — e.g. a forthcoming
 * show not yet in shows.json) is NOT counted here: adding a commercial row ahead
 * of the shows-list update must not break CI. The FULL audit (fails + warns) runs
 * daily and non-blocking in check-corpus-drift.yml, surfaced in the digest.
 *
 * @param {{gateHits:number, floor?:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockCommercialContaminationGate({ gateHits, floor = 0 }) {
  return gateHits > floor;
}

module.exports = { shouldBlockCommercialContaminationGate };
