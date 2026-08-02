/**
 * dispatch-ledger — append-only record of cmux auto-dispatch attempts, so
 * bsc-next / bsc-prune can tell "this task has already died here" from "this
 * is a fresh dispatch" instead of blind re-dispatching forever.
 *
 * Task #334 (2026-07-22): task #297 accumulated THREE dead cmux workspaces
 * (workspace:227/229/234, "Terminal surface not found") because nothing
 * recorded that all three launches were onto the same task, and a session
 * killed at the #289 >30min timeout never runs the Stop hook's ✅ self-mark
 * (that mark only exists on the SUCCESS path — see #154). bsc-next.js
 * appends a 'launch' entry on every verified dispatch; bsc-prune.js appends
 * a 'dead' entry the first time its idle-unmarked sweep finds a launched
 * workspace with no live claude process and no ✅ (the missing failure
 * breadcrumb). bsc-next.js then refuses a further blind dispatch once a
 * task has DEAD_ATTEMPT_LIMIT dead entries, instead of opening a 3rd/4th/5th
 * dead shell on the same task.
 *
 * Ledger: data/audit/dispatch-ledger.jsonl (gitignored, Mac-local — same
 * append-only-jsonl pattern as autonomous-ledger.jsonl). Never rewritten.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Hardcoded (not path.join(__dirname, '..', '..')) on purpose: both callers
// of this module (bsc-next.js, bsc-prune.js) are interactive tools an owner
// routinely runs from inside a worktree (this session included) — a
// __dirname-relative REPO would resolve to that worktree's own
// scripts/lib/, splitting the ledger into a worktree-local copy instead of
// the single canonical file every dispatch/sweep needs to share. Same fix
// bsc-next.js already applies to its own REPO/QUEUE_PATH, with the same
// rationale in its header comment. (autonomous-ledger.js gets away with the
// relative pattern because autonomous-run.js only ever runs from the
// canonical checkout via launchd — never from a worktree.)
const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl');

// A task with this many recorded 'dead' entries blocks further blind
// dispatch (bsc-next's deadDispatchGuard) until the owner investigates or
// passes --force. 2 = the 3rd dispatch attempt is the one that gets refused,
// matching the real incident (2 dead shells already existed when the 3rd
// was opened).
const DEAD_ATTEMPT_LIMIT = 2;

function appendEntry(entry, ledgerPath = LEDGER_PATH) {
  if (!entry || typeof entry.event !== 'string' || !entry.event || !entry.taskId) {
    throw new Error('dispatch-ledger entry requires an event string and a taskId');
  }
  const line = { ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  return line;
}

// Corrupt lines (partial write from a crash) are skipped, never fatal — the
// ledger must stay readable after any crash, same invariant as
// autonomous-ledger.js's readEntries.
function readEntries(ledgerPath = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

function deadAttemptsForTask(taskId, entries) {
  // Failed/orphaned headless jobs count as dead attempts too — this is the
  // "one ledger, one guard" promise: a task cannot burn unlimited headless
  // jobs just because its deaths use the job-* vocabulary (Opus ship-check P1).
  const DEADLIKE = new Set(['dead', JOB_EVENTS.FAILED, JOB_EVENTS.ORPHANED]);
  return entries.filter(e => DEADLIKE.has(e.event) && String(e.taskId) === String(taskId));
}

function launchByRef(workspaceRef, entries) {
  return entries.find(e => e.event === 'launch' && e.workspaceRef === workspaceRef) || null;
}

// Cross-reference bsc-prune's idle (no live claude, un-✅-marked) workspaces
// against the ledger's launch records, and return the NEW 'dead' breadcrumbs
// to append — one per idle workspace that (a) was actually launched by
// bsc-next.js and (b) doesn't already have a recorded death. Idempotent
// across repeated bsc-prune runs: a workspace only ever contributes one dead
// breadcrumb, however many times the sweep re-scans it.
function deadBreadcrumbs(idleWorkspaces, entries) {
  const alreadyDead = new Set(
    entries.filter(e => e.event === 'dead').map(e => e.workspaceRef)
  );
  const out = [];
  for (const w of idleWorkspaces) {
    if (alreadyDead.has(w.ref)) continue;
    const launch = launchByRef(w.ref, entries);
    if (!launch) continue; // not a bsc-next auto-dispatch — not ours to journal
    out.push({ event: 'dead', taskId: launch.taskId, subject: launch.subject, workspaceRef: w.ref, title: w.title });
  }
  return out;
}

// Entries to append when a dispatch launch FAILED verification (task #503).
// Before this, an unverified launch wrote nothing at all: the shell cmux left
// behind had no 'launch' record, so deadBreadcrumbs() skipped it ("not a
// bsc-next auto-dispatch — not ours to journal") and deadAttemptsForTask()
// counted zero deaths however many times the task was blind-redispatched.
// That is how #334's guard shipped armed and still let 10 orphan auto-shells
// and 4 duplicate dispatches accumulate on 2026-07-26.
//
// Two entries, on purpose:
//   'dead'   — makes the attempt COUNT right now, without waiting for a sweep.
//   'launch' — makes the leftover shell ATTRIBUTABLE to this task, so a later
//              bsc-prune sweep can name it instead of listing a mystery tab.
//
// ORDER MATTERS: 'dead' is written FIRST (Opus ship-check blocker, Codex).
// These are two separate appends, so a bsc-prune sweep can interleave between
// them. With 'launch' first, a sweep landing in the gap would see a launch with
// no recorded death, emit its OWN 'dead' breadcrumb, and deadAttemptsForTask()
// would then count TWO deaths for a single failed launch — tripping the
// 2-death guard off one bad dispatch. Writing 'dead' first makes every
// interleaving safe: a sweep in the gap finds no launch record for the ref and
// skips it ("not ours to journal"); any later sweep sees the existing 'dead'
// and skips it as already-recorded. No lock needed.
//
// Returns [] when cmux left no workspace behind (nothing to attribute).
function failedLaunchEntries({ taskId, subject, workspaceRef, model = null, verifyCmd = null, verifyReason = null, notionId = null, failureReason = null, deadConfirmed = true }) {
  if (!workspaceRef) return [];
  const base = { taskId: String(taskId), subject, workspaceRef, failureReason };
  const launch = { event: 'launch', ...base, model, verifyCmd, verifyReason, notionId, unverified: true };
  // deadConfirmed=false is the card #705 slow-boot case: verification gave up
  // while this launch's wrapper process was STILL RUNNING, so the workspace is
  // very likely booting a real session. Recording a 'dead' breadcrumb for it
  // would be a lie with teeth — it feeds the 2-death dispatch guard and marks
  // a LIVE shell as a corpse for the pruner. The unverified launch entry still
  // lands, so the attempt is tracked and attributable.
  return deadConfirmed ? [{ event: 'dead', ...base, title: null }, launch] : [launch];
}

// ── Owner-closed workspaces (task #578) ────────────────────────────────────
// deadBreadcrumbs above can only see workspaces cmux STILL LISTS. When the
// owner closes a tab it leaves the list entirely, so its 'launch' entry was
// orphaned: deadAttemptsForTask() counted zero deaths and the dispatch guard
// re-opened the same card, forever (owner report 2026-08-02 — 17 launches in
// one day, 194 distinct launch refs against 26 live workspaces).
//
// A closed tab is an OWNER SIGNAL ("stop working this card"), not a failure,
// so it deliberately does NOT join the DEADLIKE set — burning one of two
// retries would mean closing a tab twice to make it stop. It parks instead.
//
// Absence is weak evidence (the whole #559/#564/#567 bug family came from
// trusting one liveness signal), so three things fence this in:
//   1. Only workspace-shaped refs. 'headless:N' and ref-less launches are
//      never in a cmux listing and would park instantly — they belong to the
//      headless-liveness half of #578, not here.
//   2. Only launches newer than a recorded epoch. Without this the first
//      sweep parks every historically-closed tab, including ones that closed
//      because they FINISHED.
//   3. Only launches with no terminal entry recorded after them, which is
//      what makes ✅-then-closed workspaces (prune-closed) immune.
const WORKSPACE_REF_RE = /^workspace:\d+$/;

// Events that end a launch's life. Any of these recorded AFTER a launch means
// that launch is already reconciled and needs no vanished breadcrumb.
const TERMINAL_LAUNCH_EVENTS = new Set(['dead', 'vanished', 'prune-closed']);

function isWorkspaceRef(ref) {
  return typeof ref === 'string' && WORKSPACE_REF_RE.test(ref);
}

// Last entry per workspaceRef matching `pred`. Last-wins (not launchByRef's
// first-wins) because cmux refs are only monotonic until someone reinstalls
// it — after a counter reset, workspace:12 can belong to a 2026-07 task and a
// 2026-09 one, and the recent launch is the one a sweep is reconciling.
function lastByRef(entries, pred) {
  const m = new Map();
  for (const e of entries) {
    if (!isWorkspaceRef(e.workspaceRef) || !pred(e)) continue;
    m.set(e.workspaceRef, e);
  }
  return m;
}

// Timestamp this machine started trusting absence-means-closed. Returns null
// when unset, which every caller must treat as "do not sweep" — see
// vanishedBreadcrumbs' fail-closed guard.
function vanishEpoch(entries) {
  const e = entries.find(x => x.event === 'vanish-epoch');
  return e ? e.ts : null;
}

function vanishEpochEntry() {
  return { event: 'vanish-epoch', taskId: 'epoch' };
}

// `liveRefs`: Set of workspace refs cmux currently lists. Returns the NEW
// 'vanished' breadcrumbs to append — one per launched-but-absent workspace.
// Idempotent: a ref only ever contributes one breadcrumb, because the
// breadcrumb itself is a terminal event for the next sweep.
function vanishedBreadcrumbs(liveRefs, entries, { epochTs = null } = {}) {
  if (!(liveRefs instanceof Set)) {
    throw new Error('vanishedBreadcrumbs requires a Set of live workspace refs');
  }
  // Fail closed on both "no epoch recorded" and "cmux listed nothing". An
  // empty listing is indistinguishable from cmux being restarted, crashed, or
  // mid-reinstall — and that is precisely the moment when every ref on the
  // machine looks vanished at once.
  if (!epochTs || liveRefs.size === 0) return [];

  const lastTerminal = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event));
  const out = [];
  for (const [ref, launch] of lastByRef(entries, e => e.event === 'launch')) {
    if (liveRefs.has(ref)) continue;                       // still on screen
    if (!launch.ts || launch.ts < epochTs) continue;       // pre-epoch history is not ours to park
    const term = lastTerminal.get(ref);
    if (term && term.ts >= launch.ts) continue;            // already reconciled
    out.push({
      event: 'vanished',
      taskId: launch.taskId,
      subject: launch.subject,
      workspaceRef: ref,
      notionId: launch.notionId || null,
    });
  }
  return out;
}

// Terminal entry for a workspace bsc-prune is about to close because it is
// ✅-marked (i.e. FINISHED). Written BEFORE the close, for the same reason
// failedLaunchEntries writes 'dead' before 'launch': the two writes are
// separate appends and a concurrent sweep can land between them. Written
// after the close, that sweep would see a launched, absent, unreconciled ref
// and park a card whose work is already done.
function pruneClosedEntry(workspace, entries) {
  const launch = launchByRef(workspace.ref, entries);
  if (!launch) return null; // not a bsc-next auto-dispatch — not ours to journal
  // Idempotence for the scheduled auto-prune tick (owner escalation
  // 2026-08-02): a ✅ workspace bsc-prune SKIPS (live claude) used to get a
  // fresh terminal breadcrumb on every sweep — harmless at owner-run cadence,
  // ~288 duplicate lines/day/ref at a 5-min tick. Same already-reconciled
  // rule vanishedBreadcrumbs applies: a terminal entry at or after this
  // launch means the ref is journaled and needs nothing more.
  const term = lastByRef(entries, e => TERMINAL_LAUNCH_EVENTS.has(e.event)).get(workspace.ref);
  if (term && launch.ts && term.ts && term.ts >= launch.ts) return null;
  return {
    event: 'prune-closed',
    taskId: launch.taskId,
    subject: launch.subject,
    workspaceRef: workspace.ref,
    title: workspace.title || null,
  };
}

// Tasks currently parked by an owner tab-close. A later 'launch' clears the
// park on purpose: dispatching anyway (bsc-next --force) IS the unpark, so the
// state is self-healing rather than a trap only a remembered flag escapes.
// 'unpark' exists for clearing without dispatching.
function parkedTasks(entries) {
  const parked = new Map();
  for (const e of entries) {
    if (e.taskId == null) continue;
    const id = String(e.taskId);
    if (e.event === 'vanished') parked.set(id, e);
    else if (e.event === 'unpark' || e.event === 'launch') parked.delete(id);
  }
  return parked;
}

function unparkEntry({ taskId, reason = null }) {
  return { event: 'unpark', taskId: String(taskId), reason };
}

// Newest-parked-first, capped shape for a single digest line (card #777).
// Extracted as a pure function (CLAUDE.md §15) so autonomous-email.js and
// bsc-status.js share one tested selection instead of each re-deriving it —
// an unbounded historical replay in one email footer line becomes
// unwieldy/clipped over months and buries the card the owner most needs to
// see (ship-check finding, Codex adversarial review).
function selectParkedCardsForDigest(parked, maxShown = 10) {
  const sorted = [...parked.values()].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const shown = sorted.slice(0, maxShown).map(e => ({ taskId: e.taskId, subject: e.subject, workspaceRef: e.workspaceRef }));
  return { shown, moreCount: Math.max(0, sorted.length - maxShown) };
}

// ── Headless-job events (Autopilot v5, task #459) ──────────────────────────
// bsc-runner.js appends these; bsc-reconcile.js and bsc-status.js fold them.
// One ledger for tabs AND jobs on purpose: the dead-attempt guard must see
// every prior attempt on a task in ONE file (plan-review design finding P1-6 —
// a second ledger recreates "counts only recorded deaths" in a new shape).
// Lines stay SMALL (ids + paths, never prompt/result text) so appendFileSync
// stays within the atomic-append window; big text lives in the per-job log.
const JOB_EVENTS = Object.freeze({
  SPAWNED: 'job-spawned',   // + pid, sessionId(null until envelope), cwd, logFile, model
  DONE: 'job-done',         // + sessionId, costUSD
  FAILED: 'job-failed',     // + stage (claude-cli STAGES / autonomous-run-core vocabulary)
  ORPHANED: 'job-orphaned', // appended by bsc-reconcile when pid is dead with no terminal event
  RETRIED: 'job-retried',   // reconciler-initiated resume attempt (capped)
});

// RETRIED is terminal for the OLD jobId: a retry supersedes it with a brand-new
// job (its own spawned→done/failed chain). Leaving it open made the old id a
// permanent ghost that every tick re-orphaned (ship-check Codex blocker).
const TERMINAL_JOB_EVENTS = new Set([JOB_EVENTS.DONE, JOB_EVENTS.FAILED, JOB_EVENTS.ORPHANED, JOB_EVENTS.RETRIED]);

// Latest job state per jobId: fold events, last one wins. Returns
// Map<jobId, {jobId, taskId, event, ...lastEntryFields}>.
function foldJobs(entries) {
  const jobs = new Map();
  for (const e of entries) {
    if (!e.jobId || !String(e.event || '').startsWith('job-')) continue;
    jobs.set(e.jobId, { ...(jobs.get(e.jobId) || {}), ...e });
  }
  return jobs;
}

function openJobs(entries) {
  return [...foldJobs(entries).values()].filter(j => !TERMINAL_JOB_EVENTS.has(j.event));
}

module.exports = {
  LEDGER_PATH, DEAD_ATTEMPT_LIMIT, JOB_EVENTS, TERMINAL_JOB_EVENTS,
  TERMINAL_LAUNCH_EVENTS,
  appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs,
  failedLaunchEntries, foldJobs, openJobs,
  isWorkspaceRef, vanishEpoch, vanishEpochEntry, vanishedBreadcrumbs,
  pruneClosedEntry, parkedTasks, unparkEntry, selectParkedCardsForDigest,
};
