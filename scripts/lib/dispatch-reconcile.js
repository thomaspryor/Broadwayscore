/**
 * dispatch-reconcile.js — shared reconcile-outcomes mechanics extracted from
 * scripts/linear-drain-parked.js (BRO-2434, 1f0daa1100b, the reference impl),
 * scripts/backlog-drain.js (BRO-2508), and scripts/lib/digest-autofix.js
 * (BRO-2506) — see BRO-2542. All three independently reimplemented the same
 * bug fix (a content-hash-keyed resolved Set silently swallows a second
 * same-content dispatch's outcome) and each port required its own review
 * cycle to catch drift (e.g. a dropped Number.isFinite(ts) guard).
 *
 * Callers keep their own ledger I/O and outcome-classification vocabulary
 * (card-pass/card-fail vs. the richer card-stranded/completion-unattributed)
 * but delegate correlation (findMyJob), resolution (isDispatchResolved), and
 * the same-pass jobId race guard (claimedJobIds) here.
 */
'use strict';

const dispatchLedger = require('./dispatch-ledger.js');

// Same correlation logic across all three original copies: scan the raw
// shared dispatch-ledger for the job-spawned event THIS dispatch's child
// process caused (earliest spawn at/after our own dispatch timestamp, minus
// a 5s buffer for the gap between writing the dispatch breadcrumb and the
// child actually spawning), then follow any retry chain to read its current
// terminal state.
function findMyJob(dispatchLedgerEntries, taskId, sinceTs) {
  const sinceMs = new Date(sinceTs).getTime() - 5000;
  const spawns = (dispatchLedgerEntries || [])
    .filter((e) => e && e.event === dispatchLedger.JOB_EVENTS.SPAWNED && String(e.taskId) === String(taskId) && new Date(e.ts).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (!spawns.length) return null;
  return dispatchLedger.followRetryChain(dispatchLedgerEntries, taskId, spawns[0].jobId);
}

// A dispatch is resolved by an outcome recorded AT OR AFTER it, not by "this
// identifier has an outcome somewhere in history" — the bug all three
// original copies independently fixed (ship-check/Codex findings on
// BRO-2434, BRO-2508, BRO-2506). A card re-dispatched after its first
// attempt failed must be able to produce a SECOND outcome, or attempt-memory's
// failure streak can never advance and checkPark can never park it.
//
// Checked against the IMMUTABLE pre-pass ledgerEntries only (never entries
// emitted earlier in this SAME reconcile pass) — tagging same-pass
// breadcrumbs with `now` and cross-checking against them is wrong: `now` is
// later than every historical dispatch ts by construction, so resolving ONE
// stale dispatch this pass would immediately satisfy `>= dispatchTs` for
// every OTHER unresolved dispatch of the same identifier too, collapsing
// genuinely separate, sequential re-attempts onto one outcome.
function makeIsDispatchResolved(resolvingEvents) {
  const RESOLVING_EVENTS = resolvingEvents instanceof Set ? resolvingEvents : new Set(resolvingEvents);
  return function isDispatchResolved(ledgerEntries, identifier, dispatchTs) {
    const at = new Date(dispatchTs).getTime();
    return (ledgerEntries || []).some((e) =>
      e && String(e.cardId) === String(identifier) && e.ts &&
      RESOLVING_EVENTS.has(e.event) &&
      new Date(e.ts).getTime() >= at);
  };
}

/**
 * Generic reconcile loop. `dispatches` must already be filtered to the
 * caller's own dispatch-event rows with a Number.isFinite(ts) guard (a
 * malformed/missing ts would otherwise turn downstream Date arithmetic into
 * NaN, tripping `< orphanTimeoutH` to false and firing an immediate fail
 * instead of the intended grace window).
 *
 * opts:
 *  - identifierOf(d): string — the id isDispatchResolved/claimedJobIds key on
 *  - taskIdOf(d): string — the id passed to findMyJob (may differ, e.g.
 *    `linear:${d.identifier}`); defaults to identifierOf(d)
 *  - isDispatchResolved(ledgerEntries, identifier, dispatchTs): bool
 *  - dispatchLedgerEntries, ledgerEntries, now, orphanTimeoutH
 *  - onOrphan(d, ageH): entry|null — no job ever spawned, and ageH is
 *    already past orphanTimeoutH (caller need not re-check)
 *  - onRetriedTimeout(d, job, ageH): entry|null — chain ends at a live retry
 *    whose successor never spawned, and ageH is already past orphanTimeoutH
 *  - onTerminal(d, job): entry — job reached a terminal state
 */
function reconcileDispatches(dispatches, opts) {
  const {
    identifierOf, taskIdOf, isDispatchResolved,
    ledgerEntries, dispatchLedgerEntries, now = new Date(), orphanTimeoutH,
    onOrphan, onRetriedTimeout, onTerminal,
    findMyJob: findMyJobFn = findMyJob,
  } = opts;
  const claimedJobIds = new Set();
  const newEntries = [];
  for (const d of dispatches) {
    const identifier = identifierOf(d);
    if (isDispatchResolved(ledgerEntries, identifier, d.ts)) continue;
    const taskId = taskIdOf ? taskIdOf(d) : identifier;
    const job = findMyJobFn(dispatchLedgerEntries, taskId, d.ts);
    if (!job) {
      const ageH = (now.getTime() - new Date(d.ts).getTime()) / 3600e3;
      if (ageH < orphanTimeoutH) continue; // may still spawn — recheck next run
      const entry = onOrphan(d, ageH);
      if (entry) newEntries.push(entry);
      continue;
    }
    // a different dispatch row already resolved into this exact job this pass
    if (job.jobId && claimedJobIds.has(job.jobId)) continue;
    if (job.event === dispatchLedger.JOB_EVENTS.RETRIED) {
      const ageH = (now.getTime() - new Date(job.ts || 0).getTime()) / 3600e3;
      if (ageH < orphanTimeoutH) continue;
      const entry = onRetriedTimeout(d, job, ageH);
      if (entry) newEntries.push(entry);
      if (job.jobId) claimedJobIds.add(job.jobId);
      continue;
    }
    if (!dispatchLedger.TERMINAL_JOB_EVENTS.has(job.event)) continue; // still running
    const entry = onTerminal(d, job);
    if (entry) newEntries.push(entry);
    if (job.jobId) claimedJobIds.add(job.jobId);
  }
  return newEntries;
}

module.exports = { findMyJob, makeIsDispatchResolved, reconcileDispatches };
