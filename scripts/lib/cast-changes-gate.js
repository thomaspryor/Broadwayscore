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
 * (BRO-2752: the --gate floor excludes the calendar-driven counters, see
 * TIME_DRIVEN_COUNTERS / countGateChurn below; --strict still counts them.)
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

/**
 * Counters whose value is driven by the CALENDAR, not by scraper behavior: they
 * flip in a step function when entries added together age past a fixed threshold
 * at UTC midnight (BRO-2752: 25 [AUTO-FLAGGED] entries added the same day all went
 * stale at once, reddening main until the daily --write heal ran). They are
 * deterministic and cleared by `--write`, so they say nothing about a scraper
 * regression and must not count toward the --gate spike floor. They still count
 * toward --strict totalIssues (daily triage).
 */
const TIME_DRIVEN_COUNTERS = Object.freeze(['staleAutoFlaggedDropped', 'endedAbsencesDropped']);

/**
 * Issue count for the --gate spike floor: every counter in `counts` except the
 * calendar-driven ones. `counts` maps counter name -> number (cross-show
 * conflicts included, as a number).
 *
 * @param {Record<string, number>} counts
 * @returns {number}
 */
function countGateChurn(counts) {
  let total = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (!TIME_DRIVEN_COUNTERS.includes(name)) total += n || 0;
  }
  return total;
}

module.exports = { shouldBlockCastChangesGate, countGateChurn, TIME_DRIVEN_COUNTERS };
