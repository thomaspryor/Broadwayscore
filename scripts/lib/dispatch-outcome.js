/**
 * dispatch-outcome.js — did dispatched work actually LAND?
 *
 * The gap this closes (owner escalation 2026-08-05): nothing owns the outcome
 * of an in-flight dispatch. autonomous-acceptance-recheck.js queries
 * `--status Done,Paused` (see its line ~206), so a card that was dispatched and
 * then died — session crashed, workspace pruned, token expired mid-run, context
 * exhausted — is invisible to every automated check in the repo. It simply sits
 * `in_progress` forever. That is the mechanical reason 97 cards read
 * "in_progress" against 13 live workspaces on 2026-08-05.
 *
 * The supervisor-SESSION answer was tried four times and rotted: cards #696,
 * #706, #708, #877 are all still `in_progress`, appointed 2026-07-30..08-02 to
 * "verify live workspaces". A session cannot own a thing that outlives it. So
 * ownership has to be a function that runs whether or not anyone remembers.
 *
 * Both inputs are already written by existing machinery — nothing new to
 * instrument:
 *   - data/audit/dispatch-ledger.jsonl : `launch` events, and TERMINAL_LAUNCH_EVENTS
 *     (dead/vanished/prune-closed/remapped) when a workspace stops existing.
 *   - the task mirror                  : whether the card reached `completed`.
 *
 * Cross-referencing them is the whole idea. Deliberately a pure function so the
 * test can replay real ledger shapes (CLAUDE.md rule 15).
 */
'use strict';

const { TERMINAL_LAUNCH_EVENTS } = require('./dispatch-ledger.js');

const OUTCOMES = Object.freeze({
  LANDED: 'landed',       // card completed — the dispatch did its job
  IN_FLIGHT: 'in-flight', // launched, no terminal event yet, card still open
  ABANDONED: 'abandoned', // workspace is GONE and the card never completed
});

/**
 * @param {object[]} dispatchLedgerEntries raw data/audit/dispatch-ledger.jsonl rows
 * @param {Map<string,{status:string}>} tasksById task mirror, keyed by task id
 * @param {object} [opts]
 * @param {Set<string>} [opts.liveWorkspaceRefs] refs cmux currently reports. When
 *   supplied, a launch whose workspace is NOT live counts as terminal even if the
 *   ledger never recorded a terminal event — the cmux-crash case, where the tab
 *   vanishes without anything writing `dead`. Omit it and only the ledger is trusted.
 * @returns {{taskId:string, outcome:string, workspaceRef:string|null, subject:string|null, launchedAt:string|null}[]}
 */
function classifyDispatches(dispatchLedgerEntries, tasksById, opts = {}) {
  const live = opts.liveWorkspaceRefs || null;
  const launches = (dispatchLedgerEntries || []).filter(e => e && e.event === 'launch' && e.taskId != null);

  // Last launch per task wins: a re-dispatch supersedes an earlier attempt, and
  // scoring the stale one would report a card abandoned while its retry runs.
  const latest = new Map();
  for (const l of launches) {
    const k = String(l.taskId);
    const prev = latest.get(k);
    if (!prev || new Date(l.ts || 0).getTime() >= new Date(prev.ts || 0).getTime()) latest.set(k, l);
  }

  const out = [];
  for (const [taskId, launch] of latest) {
    const task = tasksById.get(taskId);
    const completed = !!(task && task.status === 'completed');

    // A terminal event AFTER this launch. Terminal events from a PRIOR launch of
    // the same card must not condemn this one.
    const launchMs = new Date(launch.ts || 0).getTime();
    const terminated = (dispatchLedgerEntries || []).some(e =>
      e && String(e.taskId) === taskId &&
      TERMINAL_LAUNCH_EVENTS.has(e.event) &&
      new Date(e.ts || 0).getTime() >= launchMs);

    const workspaceGone = live && launch.workspaceRef ? !live.has(launch.workspaceRef) : false;

    let outcome;
    if (completed) outcome = OUTCOMES.LANDED;
    else if (terminated || workspaceGone) outcome = OUTCOMES.ABANDONED;
    else outcome = OUTCOMES.IN_FLIGHT;

    out.push({
      taskId,
      outcome,
      workspaceRef: launch.workspaceRef || null,
      subject: launch.subject || null,
      launchedAt: launch.ts || null,
    });
  }
  return out;
}

/** Only the ones that need a human or a re-dispatch: dispatched, dead, unfinished. */
function abandonedDispatches(dispatchLedgerEntries, tasksById, opts = {}) {
  return classifyDispatches(dispatchLedgerEntries, tasksById, opts)
    .filter(r => r.outcome === OUTCOMES.ABANDONED);
}

module.exports = { OUTCOMES, classifyDispatches, abandonedDispatches };
