'use strict';

/**
 * cast-changes-gate.js — pure block/pass decision for
 * `audit-cast-changes.js --gate` (the per-push trunk catastrophe floor).
 *
 * Extracted (CLAUDE.md §15) so the gate logic is unit-tested independently of the
 * data/cast-changes.json scan, matching contamination-gate / duplicate-of-gate.
 *
 * `--strict` blocks on totalIssues > 0, where totalIssues sums every kind the
 * audit detects. Almost all of those (stale closure-date repairs, per-actor
 * departures collapsed into a closure, contradicted closures/arrivals, ended
 * absences, stale [AUTO-FLAGGED] entries, name-variant dedupes, redundant in-cast
 * arrivals) are AUTO-HEALED by the audit's own `--write` (run on schedule) — they
 * are routine churn the cast scraper introduces continuously, so blocking on a
 * handful reddens the trunk for non-code reasons in the window before --write runs.
 *
 * Two things ARE catastrophe-grade:
 *   1. crossShowConflicts — an actor placed in two shows with overlapping runs and
 *      no exit from either. This is a user-facing impossibility (the cast page
 *      shows the same person in two places at once) and `--write` does NOT fix it
 *      (it is detection-only). Zero-tolerance, like a cross-market leak.
 *   2. A mass SPIKE of churn past `floor` — the signature of a cast-scraper
 *      regression dumping bad events faster than --write can clean them, where the
 *      auto-heal would entrench rather than fix.
 *
 * The full `--strict` (block on ANY issue) runs daily in check-corpus-drift.yml,
 * surfaced non-blocking in the digest — the net for sub-floor churn.
 *
 * @param {{crossShowConflicts:number, totalIssues:number, floor:number}} counts
 * @returns {boolean} true if the trunk should be BLOCKED (exit 1)
 */
function shouldBlockCastChangesGate({ crossShowConflicts, totalIssues, floor }) {
  return crossShowConflicts > 0 || totalIssues > floor;
}

module.exports = { shouldBlockCastChangesGate };
