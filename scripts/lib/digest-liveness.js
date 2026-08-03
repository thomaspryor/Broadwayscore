/**
 * digest-liveness — never let the morning digest claim "a fix session is
 * working on it" without proof a session is actually alive right now.
 *
 * Card #940 (owner screenshots 2026-08-03): the digest listed 4 issues
 * (#733/#807/#808/#935) as "being fixed automatically" with "a fix session
 * is working on it now" — digest-autofix.js's planAutofix() derives
 * state:'in-progress' purely from the shared task list's status field
 * (matchOpenTask), which stays 'in_progress' forever if the session that
 * claimed it dies without anyone flipping it back. By 12:30 UTC (4.5h after
 * the 07:47 send) none of the four had a matching cmux workspace or
 * bsc-next --list entry — the claim was already false when it was read.
 *
 * This module is the render-time honesty gate: cross-reference a row's
 * taskId against the SAME shared dispatch-ledger.jsonl every other
 * liveness check in this repo already reads (scripts/lib/dispatch-ledger.js)
 * for two kinds of proof —
 *   - a cmux WORKSPACE launch that's still open in the ledger, whose ref
 *     still appears in a LIVE `listWorkspaces()` call, whose live title
 *     still matches the launch's recorded subject (guards against ref
 *     reuse after a cmux restart — dispatch-ledger.js's own renumber
 *     detection, findRenumberedWorkspace, uses the same titleMatchesSubject
 *     check for the identical reason), AND whose tag/process registry shows
 *     an actually-running claude_code process (isProcessAlive —
 *     cmux-workspaces.js's claudeAliveIn; existing in cmux's workspace list
 *     is not proof of a live session, only that the shell hasn't been
 *     closed — the ship-check adversarial review, 2026-08-03, caught an
 *     earlier version of this file trusting listing-presence alone, which
 *     is exactly the desync class cmux-workspaces.js's own two-signal
 *     design (checkLiveness) exists to guard against for its close-path
 *     callers).
 *   - a HEADLESS job (bsc-runner.js) with no terminal event yet
 * Neither proof existing means: no live session, whatever the task's own
 * status field claims. A 'dispatched' row (this digest run just spawned
 * it, via digest-autofix.js's dispatchDetached) is deliberately NOT gated —
 * the detached process hasn't reached bsc-runner yet, so its ledger entry
 * cannot exist; gating it would downgrade every honest fresh dispatch.
 * runAutofix's own attempt-memory reconciliation is what catches a fresh
 * dispatch that never came alive, on the NEXT run, once it has actually
 * failed.
 *
 * Known accepted gap: the headless-job proof path (openJobs) is a snapshot
 * of the shared ledger's last-recorded event, not an independent PID check
 * — a job whose process died between its last heartbeat and this read still
 * reads as open. This is the SAME standard digest-autofix.js's own
 * reconcileDigestOutcomes already applies to the identical ledger (via
 * findMyJob); this module does not lower that bar, it just gates on it at
 * render time instead of leaving it unchecked. True PID verification lives
 * in bsc-reconcile.js, which mutates ledger state and is out of scope for a
 * read-only render-time check.
 */
'use strict';

const dispatchLedger = require('./dispatch-ledger.js');

// Is there live, verifiable proof that a fix session is actually running for
// this task right now? `liveWorkspaces` is the raw array from
// cmux-workspaces.js's listWorkspaces() ({ref, title, selected}[]) — reused
// as-is rather than re-parsing `cmux list-workspaces` text a second time.
function taskHasLiveSession(taskId, { dispatchLedgerEntries = [], liveWorkspaces = [], isProcessAlive = () => true } = {}) {
  const openLaunches = dispatchLedger.openTaskWorkspaceLaunches(dispatchLedgerEntries);
  const launch = openLaunches.get(String(taskId));
  if (launch) {
    const live = (liveWorkspaces || []).find(w => w && w.ref === launch.workspaceRef);
    if (live
      && dispatchLedger.titleMatchesSubject(live.title, launch.subject)
      && isProcessAlive(launch.workspaceRef)) {
      return true;
    }
  }
  return dispatchLedger.openJobs(dispatchLedgerEntries).some(j => String(j.taskId) === String(taskId));
}

// Gate digest-autofix's planAutofix/runAutofix output before the email
// renders it. Only 'in-progress' rows are checked (see header comment for
// why 'dispatched' rows are exempt this run). A row that fails the check
// gets state:'no-live-session' — autonomous-email-render.js maps that to an
// honest label instead of "already working on it".
function applyLivenessGate(autofixRows, { dispatchLedgerEntries = [], liveWorkspaces = [], isProcessAlive = () => true } = {}) {
  if (!Array.isArray(autofixRows)) return autofixRows;
  return autofixRows.map((row) => {
    if (!row || row.state !== 'in-progress' || !row.taskId) return row;
    if (taskHasLiveSession(row.taskId, { dispatchLedgerEntries, liveWorkspaces, isProcessAlive })) {
      return { ...row, liveConfirmed: true };
    }
    return { ...row, state: 'no-live-session', priorState: 'in-progress', liveConfirmed: false };
  });
}

module.exports = { taskHasLiveSession, applyLivenessGate };
