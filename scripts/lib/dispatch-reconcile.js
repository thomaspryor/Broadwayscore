#!/usr/bin/env node
/**
 * scripts/lib/dispatch-reconcile.js — the shared mechanics for turning a
 * module's own "I dispatched this" breadcrumbs into resolved outcomes, by
 * cross-referencing the SHARED dispatch ledger's job lifecycle.
 *
 * WHY THIS EXISTS (BRO-2542). The same reconcile loop was independently
 * written three times, each port a copy-paste of the last:
 *   - scripts/linear-drain-parked.js  (BRO-2434, 1f0daa1100b — the original)
 *   - scripts/backlog-drain.js        (BRO-2508 — richest outcome vocabulary)
 *   - scripts/lib/digest-autofix.js   (BRO-2506)
 * The third port silently DROPPED the `Number.isFinite(ts)` filter the first
 * two carried, and it was caught only because two independent ship-check
 * reviewers (Claude codebase review + Codex adversarial) each happened to
 * notice the same omission. A correctness fix in one copy did not propagate
 * to its siblings; drift crept in on every port. That guard lives in the LOOP
 * FILTER, not in the helpers, which is why extracting only findMyJob/
 * isDispatchResolved would not have prevented the motivating bug — the loop
 * itself has to be the shared thing.
 *
 * THE POSTMORTEMS THIS LOOP ENCODES — do not "simplify" any of them away:
 *
 *  1. A dispatch is resolved by an outcome recorded AT OR AFTER it, never by
 *     "this identifier (or identifier+contentHash) has an outcome somewhere in
 *     history". A content-hash-keyed resolvedKeys Set collapses two dispatches
 *     of the SAME unchanged content onto one shared key — which is exactly the
 *     repeated-failure case attempt-memory's park mechanism exists to detect.
 *     A card dispatched, failed, and re-dispatched on unchanged content would
 *     never produce a SECOND card-fail at all, so the failure streak could
 *     never reach maxFailures and the card could never park. (BRO-2434, then
 *     independently BRO-2508 and BRO-2506.)
 *
 *  2. isDispatchResolved is checked against the IMMUTABLE pre-pass
 *     `ledgerEntries` ONLY — never against entries produced earlier in this
 *     same pass. An earlier draft tagged same-pass breadcrumbs with `now` and
 *     cross-checked against them, which is wrong: `now` is later than every
 *     historical dispatch ts by construction, so resolving ONE stale dispatch
 *     this pass would immediately satisfy the `>= dispatchTs` check for every
 *     OTHER unresolved dispatch of the same identifier too, collapsing
 *     genuinely separate, sequential re-attempts onto one outcome.
 *
 *  3. The real hazard that same-pass check was reaching for — two dispatch
 *     rows racing onto the SAME underlying job (a duplicate-dispatch race
 *     where only one job ever actually spawned) — is guarded directly by
 *     jobId instead: `claimedJobIds` skips a row whose job another row already
 *     resolved this pass, without touching timestamps. It is populated at the
 *     retry-timeout and terminal outcomes only; the orphan case has no jobId
 *     to claim by definition.
 *
 *  4. A malformed or missing `ts` (a hand-edited or corrupted ledger line —
 *     readLedger drops lines that aren't valid JSON, but does no field-level
 *     check) turns every downstream Date arithmetic into NaN. `NaN < timeout`
 *     is false, so the row would skip its grace window and fire an immediate
 *     failure. Same defensive Number.isFinite guard attempt-memory.js's
 *     recentlyAttempted() applies, for the same reason.
 *
 *  5. followRetryChain, not "latest ts for this taskId" (task #1184 S1): a
 *     timed-out job the reconciler resumed ends 'job-retried', and without
 *     following the chain the resumed successor's real outcome is ignored
 *     while the resume is still working.
 *
 * SHAPE. classifyDispatches RETURNS DATA — a list of {dispatch, cardId, job,
 * kind} decisions — rather than taking per-branch callbacks. That matches
 * scripts/lib/digest-liveness.js's applyLivenessGate (one option bag with
 * defaulted seam fns, returns mapped rows); there is no `on<Event>` callback-bag
 * precedent anywhere in scripts/lib/. Each caller keeps its own tiny
 * `switch (kind)` that builds its own ledger entry, so its outcome vocabulary,
 * note text, cost fields and classification stay next to its own postmortems —
 * only the correlation/resolution/race-guard mechanics are shared.
 *
 * Pure functions only — no fs, no git, no process. Ledger I/O and outcome
 * classification stay at the call sites.
 *
 * Tested by scripts/lib/dispatch-reconcile.test.mjs (CLAUDE.md rule 15 — the
 * test require()s these functions, it does not restate them), and by the three
 * callers' own suites, which must pass UNCHANGED across this extraction:
 * scripts/backlog-drain.test.mjs, scripts/lib/digest-autofix.test.mjs,
 * tests/unit/linear-drain-parked.test.mjs.
 */

'use strict';

const dispatchLedger = require('./dispatch-ledger.js');

// How far before our own dispatch timestamp a job-spawned event may sit and
// still be ours. The child process records its spawn a beat AFTER the parent
// writes the dispatch breadcrumb, but clock skew and same-second rounding can
// invert that by a hair; 5s is the slack all three call sites have always used.
const SPAWN_LOOKBACK_MS = 5000;

// The COMPLETE set of decisions classifyDispatches can return. Every call site
// branches on these members — never on the bare strings — and throws on
// anything else, so adding one is a breaking change for all of them at once.
// Frozen and exported so that contract is checkable
// (dispatch-reconcile.test.mjs asserts these exact members) rather than a
// claim in a comment. A new kind must be added here, asserted there, and
// handled at every call site in the same change.
//
// Named to match the neighbouring dispatch-ledger.js's JOB_EVENTS /
// TERMINAL_JOB_EVENTS convention: self-describing, frozen, SCREAMING_SNAKE
// keys over kebab string values, consumed namespaced.
const DECISION_KINDS = Object.freeze({
  ORPHAN: 'orphan',              // no job ever spawned, grace window expired; job is null
  RETRY_TIMEOUT: 'retry-timeout', // chain ends at job-retried, successor never spawned in the window
  TERMINAL: 'terminal',           // the job reached a terminal event; the caller decides what it MEANS
});

/**
 * Find the job THIS dispatch's child process caused, then follow any retry
 * chain to read its current terminal state.
 *
 * Deliberately NOT "the latest ledger entry for this taskId": that reads
 * another dispatch's job (an earlier or a concurrent one) whenever a task is
 * dispatched more than once, which is precisely the case reconciliation has to
 * get right. Earliest spawn at/after our own timestamp is the causal answer.
 *
 * Returns the folded job record, or null when no spawn was ever observed.
 */
function findMyJob(dispatchLedgerEntries, taskId, sinceTs) {
  const sinceMs = new Date(sinceTs).getTime() - SPAWN_LOOKBACK_MS;
  const spawns = (dispatchLedgerEntries || [])
    .filter((e) => e && e.event === dispatchLedger.JOB_EVENTS.SPAWNED
      && String(e.taskId) === String(taskId)
      && new Date(e.ts).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (!spawns.length) return null;
  return dispatchLedger.followRetryChain(dispatchLedgerEntries, taskId, spawns[0].jobId);
}

/**
 * Has an outcome been recorded AT OR AFTER this dispatch? See postmortem 1 in
 * the header for why "anywhere in history" is the bug this replaced.
 *
 * `resolvingEvents` is caller-supplied because the outcome vocabularies differ:
 * two callers resolve on {card-pass, card-fail}; backlog-drain.js also resolves
 * on card-stranded and completion-unattributed (a completed card must not be
 * re-dispatched even when the drain cannot claim credit for finishing it).
 *
 * Callers keep their own arity-3 wrapper binding their local set — the extra
 * parameter is deliberately last and required, so a caller that forgets it
 * fails loudly on `undefined.has(...)` rather than silently resolving nothing.
 */
function isDispatchResolved(ledgerEntries, cardId, dispatchTs, resolvingEvents) {
  const at = new Date(dispatchTs).getTime();
  return (ledgerEntries || []).some((e) =>
    e && String(e.cardId) === String(cardId) && e.ts &&
    resolvingEvents.has(e.event) &&
    new Date(e.ts).getTime() >= at);
}

/**
 * Walk a module's own dispatch breadcrumbs and decide, for each one that is
 * still unresolved, what kind of outcome it has earned right now.
 *
 * @param {object}   o
 * @param {object[]} o.ledgerEntries         this module's own ledger, IMMUTABLE pre-pass (postmortem 2)
 * @param {object[]} o.dispatchLedgerEntries the shared dispatch ledger's raw entries
 * @param {(e:object)=>boolean} o.isDispatchRow  is this entry one of my dispatch breadcrumbs?
 *                                               (the event-name test plus any caller-specific
 *                                               required fields — the ts guard is applied here,
 *                                               never by the caller)
 * @param {Set<string>} o.resolvingEvents    which of my own events count as an outcome
 * @param {number}   o.orphanTimeoutH        grace window, in hours, for both the no-spawn and
 *                                           retry-successor-never-spawned cases
 * @param {(d:object)=>string} o.cardIdOf    my ledger's key for this row (also the emitted cardId)
 * @param {(d:object)=>string} o.taskIdOf    the SHARED ledger's taskId for this row — often a
 *                                           namespaced form of cardIdOf (e.g. `linear:BRO-1`)
 * @param {Date}     [o.now]
 *
 * @returns {{dispatch:object, cardId:string, job:(object|null), kind:string}[]}
 *   kind is one of:
 *     'orphan'        — no job ever spawned, and the grace window has expired.
 *                       job is null. The likely causes are caller-specific
 *                       (kill switch, runner disabled, live cmux duplicate,
 *                       already-started issue, lease held, verify gate), so the
 *                       note is the caller's to write.
 *     'retry-timeout' — the retry chain ends at 'job-retried' whose successor
 *                       never spawned inside the same grace window: the resume
 *                       child died before spawning.
 *     'terminal'      — the job reached a terminal event. The caller decides
 *                       what that MEANS (a finished session is not automatically
 *                       a pass — backlog-drain.js additionally weighs card
 *                       status, stranded commits and branch attribution).
 *
 * Rows still legitimately in flight — unresolved but inside their grace window,
 * or on a job another row already claimed this pass, or on a job with no
 * terminal event yet — are simply absent from the result. Absence means "ask
 * again next pass", never "nothing happened".
 */
function classifyDispatches({
  ledgerEntries,
  dispatchLedgerEntries,
  isDispatchRow,
  resolvingEvents,
  orphanTimeoutH,
  cardIdOf,
  taskIdOf,
  now = new Date(),
} = {}) {
  // Postmortem 4 applies to the CLOCK as well as to the rows, and all three
  // copies missed that half. Every grace-window test here is `ageH < timeout`,
  // so a `now` that yields NaN makes each comparison false and fires an
  // immediate failure for EVERY unresolved dispatch at once — the whole board
  // scored failed in a single pass, cards parked, spend breaker tripped, with
  // notes that read like ordinary timeouts. Loud and early beats that.
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`classifyDispatches: \`now\` must be a valid Date (got ${JSON.stringify(now)})`);
  }
  // A non-array ledger is a caller bug, not a data condition: findMyJob would
  // read it as "no job ever spawned" and every dispatch would age into an
  // orphan failure, silently, on a schedule. dispatch-ledger.readEntries()
  // always returns an array, so this only fires through an injected seam —
  // exactly where a mistake would otherwise go unnoticed.
  if (!Array.isArray(dispatchLedgerEntries)) {
    throw new TypeError('classifyDispatches: `dispatchLedgerEntries` must be an array');
  }
  // Entries written before a given feature shipped carry no contentHash and are
  // excluded by the caller's own isDispatchRow — the same convention
  // attempt-memory.js's header documents for pre-feature ledger history. The ts
  // guard, by contrast, is applied HERE for every caller: it is the check that
  // drifted away on the last copy-paste port (postmortem 4).
  const dispatches = (ledgerEntries || []).filter((e) =>
    e && isDispatchRow(e) && Number.isFinite(new Date(e.ts).getTime()));

  // Jobs already resolved into an outcome THIS pass (postmortem 3).
  const claimedJobIds = new Set();
  const decisions = [];

  for (const dispatch of dispatches) {
    const cardId = cardIdOf(dispatch);
    if (isDispatchResolved(ledgerEntries, cardId, dispatch.ts, resolvingEvents)) continue;

    const job = findMyJob(dispatchLedgerEntries, taskIdOf(dispatch), dispatch.ts);

    if (!job) {
      const ageH = (nowMs - new Date(dispatch.ts).getTime()) / 3600e3;
      if (ageH < orphanTimeoutH) continue; // may still spawn — recheck next pass
      decisions.push({ dispatch, cardId, job: null, kind: DECISION_KINDS.ORPHAN });
      continue;
    }

    // A different dispatch row already resolved into this exact job this pass.
    if (job.jobId && claimedJobIds.has(job.jobId)) continue;

    if (job.event === dispatchLedger.JOB_EVENTS.RETRIED) {
      // Chain ends at a retry whose successor hasn't spawned yet: still
      // in-flight within the same grace window the no-spawn case uses.
      const ageH = (nowMs - new Date(job.ts || 0).getTime()) / 3600e3;
      if (ageH < orphanTimeoutH) continue;
      decisions.push({ dispatch, cardId, job, kind: DECISION_KINDS.RETRY_TIMEOUT });
      if (job.jobId) claimedJobIds.add(job.jobId);
      continue;
    }

    if (!dispatchLedger.TERMINAL_JOB_EVENTS.has(job.event)) continue; // still running

    decisions.push({ dispatch, cardId, job, kind: DECISION_KINDS.TERMINAL });
    if (job.jobId) claimedJobIds.add(job.jobId);
  }

  return decisions;
}

// How long a dispatch gets to produce a spawn before reconciliation calls it an
// orphan. Hoisted here (BRO-3321) because all three reconcilers were declaring
// their own `const ORPHAN_TIMEOUT_H = 3` — digest-autofix.js, backlog-drain.js,
// linear-drain-parked.js — while all three then passed it straight back into
// this module's classifyDispatches as `orphanTimeoutH`. Three independent
// copies of one number that has to agree is a drift class waiting to happen;
// the owner of the timing is the module that acts on it.
const ORPHAN_TIMEOUT_H = 3;

/**
 * WHEN is an outcome row ABOUT? Not when it was written.
 *
 * Every ledger writer in this family stamps `ts` at append time
 * (`{ ts: new Date().toISOString(), ...entry }` — scripts/lib/digest-autofix.js,
 * scripts/backlog-drain.js, scripts/linear-drain-parked.js). For an
 * 'auto-dispatch'/'drain-dispatch' breadcrumb that is correct: the write IS the
 * event. For a 'card-pass'/'card-fail' it is not — those are written by a
 * RECONCILIATION pass that can run arbitrarily long after the dispatch it
 * judges, so `ts` records when we got around to looking, not when the work
 * happened.
 *
 * That gap is not hypothetical. On 2026-09-14 the morning digest reconciled
 * three dispatches from 2026-08-14 — thirty-one days stale, because the digest
 * itself had not run in between — and stamped all three card-fails with the
 * reconciliation time. assessAutofixEffectiveness's trailing-7d window read
 * them as three fresh failures and emailed the owner "Auto-fix loop is DEAD:
 * 0 of 3 job(s) succeeded in the last 7d" while, in the same pass, three
 * genuinely new dispatches (BRO-352/471/472) spawned and reached job-done
 * inside the hour. A dead-loop alarm that a month-old backlog can trigger, and
 * that a live healthy loop cannot silence, is worse than no alarm: it taught
 * the owner to distrust the one row built to tell him the fleet had stopped
 * fixing things.
 *
 * So outcome rows now carry `judgedDispatchTs` (the judged dispatch's own ts)
 * and windowing consumers age them by THAT. `ts` stays honest about when the
 * row was written. Falls back to `ts` for rows written before this field
 * existed — dating those by write time is exactly as wrong as it was, but no
 * worse, and they age out of every window on their own.
 *
 * DO NOT reach for this in three places that deliberately want WRITE time:
 *   1. isDispatchResolved (below). Resolution asks "has an outcome been
 *      RECORDED at or after this dispatch" — ordering by anything but write
 *      time reopens postmortems 1-2 in this file's header (BRO-2506/2434/2508),
 *      where a dispatch could be resolved by an outcome that predated it.
 *   2. scripts/lib/attempt-memory.js:65-70. checkPark sorts outcomes by `ts`
 *      and compares them against an owner's manual override timestamp. An
 *      override at time T must supersede everything RECORDED before T,
 *      whenever the underlying dispatch happened — dispatch time would let a
 *      stale outcome survive an override that was meant to clear it.
 *   3. scripts/lib/backlog-drain.js:141 computeSpendCircuitBreaker. Spend is
 *      CONFIRMED at reconcile time, and its window is only 24h. Measured on the
 *      real ledger (n=55): median dispatch->outcome lag 4h, max 140h, 2 rows
 *      past 24h. Aged by dispatch time those two rows' cost falls out of the
 *      window entirely and the breaker never sees the money — a breaker that
 *      under-counts fails OPEN, which is the one direction a spend guard must
 *      never fail.
 */
function outcomeWindowTs(row) {
  if (!row) return undefined;
  return row.judgedDispatchTs || row.ts;
}

module.exports = { findMyJob, isDispatchResolved, classifyDispatches, DECISION_KINDS, outcomeWindowTs, ORPHAN_TIMEOUT_H };
