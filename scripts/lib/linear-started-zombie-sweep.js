'use strict';

/**
 * linear-started-zombie-sweep.js — pure decision logic for BRO-3925 (P1,
 * backlog-drain R4, parent BRO-3913).
 *
 * The gap: a Linear issue in a 'started' state (In Progress / In Review)
 * whose LATEST dispatch attempt's dispatch-ledger job actually finished
 * (bsc-runner.js's runJob() wrote JOB_EVENTS.DONE — a real "session exited
 * cleanly and its work landed on origin/main" outcome, not blocked/stranded/
 * stopped-short) can still sit stuck forever if the session never called
 * `node scripts/linear-session.js report ...` before ending: no write-back
 * comment, no state transition. linear-watchdog-source.js's ineligibleReason
 * refuses every 'started'-type issue ('already-started'), so nothing ever
 * re-dispatches it, and BRO-3376's human In-Review triage is the only other
 * eye on it. A 2026-09-21 hand test (BRO-2961, BRO-3057) proved a manually
 * reset card gets picked up by the watchdog within 3 minutes — but also
 * found that all 5 real candidates it inspected had their job worktree
 * already garbage-collected. That is EXPECTED, not a bug: bsc-runner.js's
 * runJob() tears down a job's worktree in its own `finally` block whenever
 * it is clean and not ahead of origin/main (see teardownJobWorktree), which
 * is exactly the condition JOB_EVENTS.DONE implies — so a worktree still
 * existing at sweep time is already the RARE case (the teardown itself threw
 * and was caught non-fatally), and "worktree gone" fails closed to a refusal
 * by design, not a workaround.
 *
 * Modeled on scripts/lib/linear-dead-completion-source.js's
 * findLinearDeadLaunchCandidates/shouldReopenLinearIssue split (ledger-only
 * candidate scan, pure; caller does the live Linear fetch to confirm before
 * touching anything) — same shape, inverted predicate (latest attempt is
 * DONE with no report, not dead).
 *
 * No I/O here — scripts/bsc-reconcile.js's sweepLinearStartedZombies() does
 * every fetch/fs/git/Linear-write call and passes plain data in.
 */

const {
  JOB_EVENTS,
  latestAttemptForTask,
  foldJobs,
} = require('./dispatch-ledger.js');
const { parseLinearTaskId } = require('./linear-watchdog-source.js');
const { parseSessionReportStatus } = require('./linear-session-reporting.js');
const { DISPATCH_COMMENT_CORRELATION_RE, isCompletePrEvidence } = require('./linear-dispatch.js');
const { checkPark, computeContentHash } = require('./attempt-memory.js');

/**
 * Every distinct `linear:BRO-N` taskId whose LATEST dispatch-ledger attempt
 * is a finished job (JOB_EVENTS.DONE) — pure, ledger-only, zero Linear API
 * calls, so this is cheap enough to run on every sweep tick regardless of
 * how large the ledger or the Linear backlog grows.
 *
 * `cwd` comes from foldJobs()'s merged job record (job-done carries no `cwd`
 * of its own, so the spawn's value survives the shallow merge untouched).
 * `spawnedTs` does NOT — job-done's own `ts` clobbers job-spawned's on that
 * same merge — so it is recovered from a targeted scan for the raw SPAWNED
 * entry for this exact jobId. The "no write-back SINCE" window has to start
 * at spawn time, not completion time (mirrors linear-dispatch.js's own
 * dispatchFloor() reasoning for the equivalent headless-dispatch-comment
 * problem: the work happens between spawn and done, so anything after spawn
 * counts).
 *
 * @param {Array<object>} entries dispatch-ledger.jsonl entries
 * @returns {Array<{identifier: string, taskId: string, jobId: string, cwd: string|null, spawnedTs: string|null}>}
 */
function findJobDoneLinearCandidates(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const taskIds = new Set();
  for (const e of list) {
    const identifier = parseLinearTaskId(e && e.taskId);
    if (identifier) taskIds.add(String(e.taskId));
  }
  const jobs = foldJobs(list);
  const out = [];
  for (const taskId of taskIds) {
    const latest = latestAttemptForTask(taskId, list);
    if (!latest || latest.event !== JOB_EVENTS.DONE || !latest.jobId) continue;
    const job = jobs.get(latest.jobId);
    if (!job) continue;
    let spawnedTs = null;
    for (const e of list) {
      if (e && e.jobId === latest.jobId && e.event === JOB_EVENTS.SPAWNED) spawnedTs = e.ts || null;
    }
    out.push({
      identifier: parseLinearTaskId(taskId),
      taskId,
      jobId: latest.jobId,
      cwd: job.cwd || null,
      spawnedTs,
    });
  }
  return out;
}

// Oldest-first, same comparator shape as linear-dispatch.js's
// sortedCommentBodies — that file's own header documents multiple prior
// incidents of code trusting Linear's `comments` connection order (it is
// NOT createdAt-ascending by default). buildIssueQuery() does pass
// `orderBy: createdAt`, but sorting again here costs nothing and means this
// function's correctness never depends on a query text elsewhere staying
// exactly right, or on what a test/future caller's getIssueFn substitutes.
function sortedComments(issue) {
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  return nodes.slice().sort((a, b) => {
    const ca = String((a && a.createdAt) || '');
    const cb = String((b && b.createdAt) || '');
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
}

// Literal substring embedded in this sweep's own write-back comment (see
// buildZombieResetSummary below) — the ONE marker that lets decideZombieReset
// tell "a genuine session report from the dispatched worker" apart from "our
// own prior write-back attempt" when it re-scans the same candidate on a
// later tick. Load-bearing: without it, a PARTIAL failure of cmdReport (the
// comment posts successfully but the state-transition call that follows it
// throws — see scripts/linear-session.js's cmdReport, comment then
// getTeam()/updateIssue()) leaves the issue still 'started' with our own
// "**Session report (paused)**"-prefixed comment sitting on the thread. The
// NEXT sweep tick would otherwise read that comment via
// parseSessionReportStatus() as proof `linear-session.js report` genuinely
// ran and skip it as 'already-reported' forever — permanently masking a
// stuck card behind the exact write-back that was supposed to unstick it.
const ZOMBIE_RESET_MARKER = "Auto-reset by bsc-reconcile's Linear zombie sweep (BRO-3925)";

// buildIssueQuery (linear-dispatch.js) fetches `comments(first: 50, orderBy:
// createdAt)` with no pagination cursor. Hitting exactly this cap is the only
// available signal that older/newer comments exist beyond what was fetched —
// Linear's `orderBy: createdAt` connection default is ascending, so a
// truncated 50-of-N thread silently drops the MOST RECENT comments, exactly
// the ones a human intervention or a genuine report would show up in. A
// truncated thread cannot prove "no human comment since dispatch", so it
// must refuse rather than silently trust an incomplete view.
const COMMENT_PAGE_CAP = 50;

/**
 * The fail-closed decision for one candidate. Pure — every input is plain
 * data the caller already fetched/computed.
 *
 * @param {object} p
 * @param {object} p.issue fetched Linear issue ({state:{type}, comments:{nodes}})
 * @param {string|null} p.spawnedTs job-spawned's own ts (ISO), or null
 * @param {{exists: boolean, dirty?: boolean, aheadCount?: number|null, error?: boolean}} p.worktree
 * @param {boolean} p.live true if any liveness check found this job's cwd still in use
 * @returns {{action: 'skip'|'refuse'|'reset', reason: string}}
 */
function decideZombieReset({ issue, spawnedTs, worktree, live } = {}) {
  const stateType = issue && issue.state && issue.state.type;
  if (stateType !== 'started') return { action: 'skip', reason: 'not-started' };

  // No spawnedTs to compare against — this candidate cannot be placed in
  // time safely. Same "absent ordering info -> fail toward inaction" posture
  // linear-dispatch.js's own guards take on a missing createdAt.
  if (!spawnedTs) return { action: 'refuse', reason: 'no-spawned-ts' };

  const commentNodes = (issue && issue.comments && issue.comments.nodes) || [];
  if (commentNodes.length >= COMMENT_PAGE_CAP) {
    return { action: 'refuse', reason: 'comment-history-truncated' };
  }

  for (const c of sortedComments(issue)) {
    const ts = String((c && c.createdAt) || '');
    if (!(ts > spawnedTs)) continue;
    const body = String((c && c.body) || '');
    // Our OWN prior write-back, still sitting on a still-'started' issue:
    // proof a PRIOR reset attempt posted its comment but the state-transition
    // half never landed (see ZOMBIE_RESET_MARKER above) — refuse with a
    // distinct reason rather than reading our own comment as "already
    // reported" and silently forgetting this card forever.
    if (body.includes(ZOMBIE_RESET_MARKER)) {
      return { action: 'refuse', reason: 'own-reset-attempt-unconfirmed' };
    }
    // A session-report comment (ANY status — done/in-review/paused/blocked)
    // proves `linear-session.js report` DID run: this was never a zombie,
    // whatever the state transition ended up being. A complete PR-EVIDENCE
    // line is the same proof for a worker that reported in its own words.
    if (parseSessionReportStatus(body) || isCompletePrEvidence(body)) {
      return { action: 'skip', reason: 'already-reported' };
    }
    // A machine "Dispatched <corr> to <ref> at <ts> (<mode>)" breadcrumb is
    // not a human comment — it is the SAME dispatch's own launch marker (or,
    // rarely, a later redispatch's — either way, not evidence of a human on
    // the thread).
    if (DISPATCH_COMMENT_CORRELATION_RE.test(body.trim())) continue;
    // Anything else since spawn: fail closed. Cannot distinguish "the owner
    // commented" from "a machine posted something unrecognized" by author —
    // every comment lands under the owner's own Linear API key — so content
    // shape is the only signal, and an unrecognized shape must be treated as
    // a human on the thread (BRO-3376 coordination clause: never touch a
    // card someone is visibly on).
    return { action: 'refuse', reason: 'human-comment-since-dispatch' };
  }

  if (!worktree || worktree.exists === false) return { action: 'refuse', reason: 'worktree-gone' };
  if (worktree.error || worktree.dirty || (worktree.aheadCount !== 0)) {
    return { action: 'refuse', reason: 'worktree-unsafe' };
  }
  if (live) return { action: 'refuse', reason: 'live-process' };

  return { action: 'reset', reason: 'clean-finished-job-no-writeback' };
}

// Write-back comment body — handed to linear-session.js's cmdReport as
// --summary. Names the reason so a human reading the issue's own comment
// thread later understands why the state moved without asking them. MUST
// contain ZOMBIE_RESET_MARKER verbatim — that is the exact substring
// decideZombieReset scans for above.
function buildZombieResetSummary({ identifier, jobId, reason } = {}) {
  return `${ZOMBIE_RESET_MARKER}: ${identifier}'s most recent dispatch `
    + `(job ${jobId || '(unknown)'}) finished cleanly but never reported back, leaving the issue stuck in a `
    + `started state with no live session, worktree, or work at risk. Moved to Backlog so it is re-eligible for `
    + `dispatch. Reason: ${reason || 'clean-finished-job-no-writeback'}.`;
}

// jobId, NOT description: idempotency/park state lives ONLY in this sweep's
// own dedicated local ledger (data/audit/bsc-reconcile-linear-zombie-
// ledger.jsonl), never written into the Linear issue body ("no description
// sentinel" per the plan) — computeContentHash's {name, notes} shape is
// reused verbatim (same convention scripts/linear-drain-parked.js already
// established for its own ledger), just fed jobId instead of description so
// a REDISPATCH (new jobId) always resets the streak, matching "a card was
// edited" resetting the streak in the original park design.
function computeZombieContentHash({ title, jobId } = {}) {
  return computeContentHash({ name: title, notes: jobId });
}

// Thin wrapper over attempt-memory.js's existing checkPark, scoped to this
// sweep's own dedicated ledger — exported so a future caller (or a
// diagnostic script) can ask "is this card currently zombie-parked" without
// re-deriving the ledger-read/checkPark call.
function isZombieResetParked(identifier, { ledgerEntries, contentHash } = {}) {
  return checkPark(ledgerEntries || [], identifier, contentHash);
}

// LOCAL calendar day (not UTC — a UTC bucket rolls the owner's "N/day" cap
// at ~8pm ET). Same formula as dispatch-watchdog-core.js's own localDay(),
// not imported from there: that module is the watchdog this sweep is
// explicitly NOT part of (BRO-3925's own title), and a 3-line date formatter
// is cheaper to duplicate than to couple the two.
function zombieLocalDay(tsOrMs) {
  const d = new Date(tsOrMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
  findJobDoneLinearCandidates,
  decideZombieReset,
  buildZombieResetSummary,
  computeZombieContentHash,
  isZombieResetParked,
  zombieLocalDay,
  ZOMBIE_RESET_MARKER,
  COMMENT_PAGE_CAP,
  // Re-exported for tests that want to assert on the raw sort without
  // reimplementing it (CLAUDE.md rule 15).
  sortedComments,
};
