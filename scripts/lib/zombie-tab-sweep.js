/**
 * zombie-tab-sweep.js — classify dead 🤖 auto-dispatched workspaces whose
 * task state makes them safe to act on (owner escalations 2026-08-02 and
 * 2026-08-03: "tabs stuck not started until I click into them").
 *
 * The failure class: cmux (post-restart, or while the app is unfocused)
 * creates a workspace whose surface never attaches to a window
 * (`surface-health` reports in_window=false), so the launch command never
 * executes. The #900 wake/activation escalation reduces but does not
 * eliminate these. The #883 reconciler only rescues IN_PROGRESS tasks with
 * dead sessions — a never-booted launch leaves its task PENDING, which no
 * safety net watched. bsc-prune's idle-unmarked listing saw these tabs but
 * was forbidden to act ("NOT closed, review yourself").
 *
 * This module is the pure decision half (task #15-pattern: logic in lib,
 * bsc-prune wires I/O). Buckets:
 *   corpses — dead 🤖 tab whose task is already completed, OR whose task
 *             has another LIVE workspace with the same taskId, OR (only when
 *             the ledger has NO taskId for the dead tab) an identically
 *             titled live tab. Close; work is done or running elsewhere.
 *   revive  — dead 🤖 tab whose task is still pending: the launch never ran.
 *             The CALLER closes the husk and re-dispatches headless — and
 *             must apply BOTH the deadAttemptsForTask recurrence cap
 *             (bsc-next's --headless path never reaches its own
 *             deadDispatchGuard — verified 2026-08-03) AND the per-tick
 *             fan-out cap AFTER that guard, so guarded tasks never burn
 *             cap slots (ship-check catch).
 *   report  — dead 🤖 tab we can't map to a task (no launch entry, no task
 *             file) or whose task is in_progress (the #883 reconciler's
 *             territory — never race it). Listed, never touched.
 *
 * Only 🤖 auto-dispatched tabs are ever candidates (owner rule 2026-08-02,
 * same boundary as the no-payload reaper) — the caller pre-filters, and
 * classify() re-checks via the injected marker fn as defense in depth.
 */

const REVIVE_CAP_PER_TICK = 2; // spend safety: never fan out more than 2 headless re-dispatches per 5-min sweep

// Canonical crown predicate, imported rather than re-derived (CLAUDE.md: a
// predicate that must agree with another module's is required from it, never
// copied). Pure regex test, no I/O, so it needs no injection seam like the
// other collaborators above.
const { isCrownTab } = require('./prune-closeable.js');

/**
 * @param {Array<{ref:string,title:string,selected?:boolean}>} deadAutoTabs
 *        dead-by-both-signals workspaces (bsc-prune's `idle` bucket).
 * @param {Array<{ref:string,title:string}>} liveWorkspaces every OTHER
 *        currently-listed workspace (for duplicate detection).
 * @param {(ref:string)=>({taskId:string|number,subject?:string}|null)} launchByRef
 *        must return the LATEST launch for the ref — cmux recycles refs
 *        across restarts, so a first-match lookup misattributes (Codex catch).
 * @param {(taskId:string)=>(string|null)} taskStatusById status from the
 *        shared task store (live dir + archive fallback), or null when the
 *        task file is missing everywhere.
 * @param {(title:string)=>boolean} hasAutoDispatchMarker
 */
function classifyZombieTabs({ deadAutoTabs, liveWorkspaces, launchByRef, taskStatusById, hasAutoDispatchMarker }) {
  const corpses = [];
  const revive = [];
  const report = [];

  const liveByTitle = new Set(liveWorkspaces.map(w => normalizeTitle(w.title)));
  const liveTaskIds = new Set();
  for (const w of liveWorkspaces) {
    const launch = safeLaunch(launchByRef, w.ref);
    if (launch && launch.taskId != null) liveTaskIds.add(String(launch.taskId));
  }

  for (const w of deadAutoTabs) {
    if (w.selected || !hasAutoDispatchMarker(w.title)) continue; // never the selected tab, never a non-🤖 tab

    const launch = safeLaunch(launchByRef, w.ref);
    const taskId = launch && launch.taskId != null ? String(launch.taskId) : null;
    const status = taskId ? taskStatusById(taskId) : null;
    const entry = { ref: w.ref, title: w.title, taskId, subject: (launch && launch.subject) || null, status };

    // Crown (owner-loop) tab: REPORT it, never close it and never headlessly
    // revive it (task #1751). Reported rather than `continue`d so a dead owner
    // loop stays visible to whoever reads the sweep — silently dropping it from
    // all three buckets is how an owner tab goes missing unnoticed, which is
    // the failure this whole exemption exists to stop. Reviving is deliberately
    // withheld too: re-crowning is an owner decision that must go through the
    // dispatch ledger, not a headless 5-minute sweep. Placed AFTER the ledger
    // lookup so the report carries the taskId/subject a human would need.
    if (isCrownTab(w.title)) { report.push({ ...entry, reason: 'crown-tab' }); continue; }

    if (status === 'completed') { corpses.push({ ...entry, reason: 'task-completed' }); continue; }
    // Duplicate: same task already has a LIVE workspace. Title equality is
    // ONLY consulted when the ledger has no taskId for the dead tab — two
    // DIFFERENT tasks can share a title prefix, so for mapped tabs the task
    // id is the sole authority (GPT/Codex catch: the earlier 40-char-prefix
    // match could close a pending sibling task as a "duplicate"). Full
    // normalized-title equality, no prefix slice, for the unmapped case:
    // re-dispatch dups get their identical title from the same card name.
    const isDup = (taskId && liveTaskIds.has(taskId)) || (!taskId && liveByTitle.has(normalizeTitle(w.title)));
    if (isDup) { corpses.push({ ...entry, reason: 'live-duplicate' }); continue; }
    if (status === 'pending') { revive.push(entry); continue; }
    // in_progress → #883 reconciler's job; unknown mapping → too little
    // evidence to close someone's tab. Both are report-only.
    report.push({ ...entry, reason: status === 'in_progress' ? 'reconciler-territory' : 'unmapped' });
  }

  return { corpses, revive, report };
}

function safeLaunch(launchByRef, ref) {
  try { return launchByRef(ref) || null; } catch { return null; }
}

function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim();
}

module.exports = { classifyZombieTabs, normalizeTitle, REVIVE_CAP_PER_TICK };
