'use strict';

/**
 * landed-but-open-reconciler.js — pure classifier for BRO-2558.
 *
 * reconcile-dead-completions.js (card #1144) catches cards marked done that
 * were not. This is the opposite direction, and the more common one measured
 * 2026-08-31: 38 of 144 "In Progress" Linear issues already had a merge
 * commit on origin/main. That inflates every queue count the fleet reports
 * and buries genuinely-open work behind stale In-Progress cards.
 *
 * Merge-commit presence ALONE is not sufficient to call a card closable — two
 * counterexamples found in the same 2026-08-31 pass:
 *
 *   - BRO-80 has a merge commit on main from an earlier run AND is actively
 *     being worked right now by a live dispatched worker. Closing it would
 *     kill in-flight work.
 *   - BRO-516 ("CANARY: touch data/audit/canary-2026-08-20.marker") looks
 *     landed by title similarity to a sibling card, but its own acceptance
 *     marker is missing and its last dispatch-ledger event is job-failed.
 *
 * classifyLandedButOpen() requires ALL FOUR of:
 *   1. a merge commit on origin/main for this card's branch
 *   2. no live dispatch, no live worktree/job lease, and no unresolved
 *      dispatch comment on the issue thread itself (nobody is actively
 *      working it right now — including on ANOTHER host: dispatch-ledger.js
 *      and job-leases are host-local by design, so a comment-thread check is
 *      the only cross-machine signal available)
 *   3. the card's own most recent dispatch-ledger event is a terminal
 *      SUCCESS (job-done) — not job-failed/job-orphaned/dead/absent
 *   4. the card's own acceptance-criteria command, re-run against a fresh
 *      origin/main checkout, actually PASSES (scripts/lib/acceptance-check-
 *      core.js — reused, not a fourth definition of "done")
 *
 * Gate 2 must be re-checked by the CALLER immediately before reporting a
 * verdict of closable, not only once up front: gate 4 can take up to ~10
 * minutes per card (autonomous-checks.js CHECK_TIMEOUT_MS x 2 attempts), and
 * a dispatch that starts mid-sweep would otherwise be invisible to a verdict
 * computed from a stale snapshot (adversarial review finding, BRO-2558).
 * scripts/reconcile-landed-but-open.js's main() re-derives liveDispatch/
 * liveLease/crossMachineDispatch a second time, right after gate 4 returns
 * 'pass', before calling this function for the final verdict.
 *
 * This module is pure decision logic only (no fs/git/network I/O) so it can
 * be require()d directly by tests (CLAUDE.md rule 15) — scripts/reconcile-
 * landed-but-open.js does the I/O and builds the evidence object this reads.
 * Report-only by design (BRO-2313's precedent for the sibling reconciler):
 * nothing in this module — or its CLI — closes an issue.
 */

// The one ledger event this file treats as "the dispatched work finished
// successfully" — matches dispatch-ledger.js's JOB_EVENTS.DONE. Duplicated as
// a literal (not required from dispatch-ledger.js) to keep this module
// dependency-free; scripts/reconcile-landed-but-open.js is what threads the
// real JOB_EVENTS.DONE constant into the evidence it builds.
const SUCCESS_LEDGER_EVENT = 'job-done';

/**
 * @param {object} evidence
 * @param {boolean} evidence.hasMergeCommit - a commit on origin/main matches this card's branch
 * @param {string|null} [evidence.mergeCommit] - the matching sha, for the report line
 * @param {boolean} [evidence.liveDispatch] - dispatch-ledger shows a live (non-dead, non-finished) entry
 * @param {boolean} [evidence.liveLease] - a job/worktree lease for this task is held by a live process
 * @param {boolean} [evidence.crossMachineDispatch] - the issue's OWN comment thread shows an unresolved "Dispatched ..." comment (a DIFFERENT host's local ledger/lease is invisible to this one — dispatch-ledger.js/linear-dispatch.js are host-local by design)
 * @param {string|null} [evidence.lastLedgerEvent] - the most recent dispatch-ledger event for this task
 * @param {'pass'|'fail'|'unverifiable'|null} [evidence.acceptanceStatus] - re-run result of the card's own acceptance command against fresh origin/main
 * @returns {{closable: boolean, reasons: string[]}}
 */
function classifyLandedButOpen(evidence = {}) {
  const {
    hasMergeCommit = false,
    mergeCommit = null,
    liveDispatch = false,
    liveLease = false,
    crossMachineDispatch = false,
    lastLedgerEvent = null,
    acceptanceStatus = null,
  } = evidence || {};

  const reasons = [];

  if (!hasMergeCommit) {
    reasons.push("no merge commit found on origin/main for this card's branch");
    return { closable: false, reasons };
  }
  reasons.push(`merge commit found on origin/main${mergeCommit ? ` (${mergeCommit})` : ''}`);

  // Gate 2, checked BEFORE the ledger's own success event: a live dispatch
  // (BRO-80's shape) can itself be the thing about to WRITE that job-done
  // event — closing on a stale merge commit while a live worker is still
  // running would race the same card's own in-flight completion.
  if (liveDispatch || liveLease || crossMachineDispatch) {
    reasons.push(liveDispatch
      ? 'dispatch-ledger shows a live (non-dead, non-finished) entry for this card — do not close in-flight work'
      : liveLease
        ? 'a live job/worktree lease is held for this card — do not close in-flight work'
        : "the issue's own comment thread shows an unresolved dispatch on ANOTHER host (this host's local ledger/lease can't see it) — do not close in-flight work");
    return { closable: false, reasons };
  }
  reasons.push('no live dispatch or lease (local or cross-machine)');

  if (lastLedgerEvent !== SUCCESS_LEDGER_EVENT) {
    reasons.push(`most recent dispatch-ledger event is "${lastLedgerEvent || 'none'}", not "${SUCCESS_LEDGER_EVENT}"`);
    return { closable: false, reasons };
  }
  reasons.push(`most recent dispatch-ledger event is "${SUCCESS_LEDGER_EVENT}"`);

  if (acceptanceStatus !== 'pass') {
    reasons.push(`acceptance-criteria re-check against origin/main did not pass (status: ${acceptanceStatus || 'not run'})`);
    return { closable: false, reasons };
  }
  reasons.push('acceptance-criteria command re-verified passing against origin/main');

  return { closable: true, reasons };
}

// Last entry (by file/append order — the ledger is append-only chronological,
// same trust-file-order convention dispatch-ledger.js's own
// latestAttemptForTask uses) whose taskId matches. Pure: entries are passed
// in, no readEntries() call here — the CLI owns the one readEntries() call
// and reuses it across every candidate card in a sweep.
function lastLedgerEntryForTask(taskId, entries) {
  let last = null;
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    if (String(e.taskId) !== String(taskId)) continue;
    last = e;
  }
  return last;
}

function lastLedgerEventForTask(taskId, entries) {
  const last = lastLedgerEntryForTask(taskId, entries);
  return last ? last.event : null;
}

module.exports = { classifyLandedButOpen, lastLedgerEventForTask, lastLedgerEntryForTask, SUCCESS_LEDGER_EVENT };
