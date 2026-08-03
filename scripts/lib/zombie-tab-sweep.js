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
 *             has another LIVE workspace (duplicate launch). Close; work is
 *             done or running elsewhere.
 *   revive  — dead 🤖 tab whose task is still pending: the launch never ran.
 *             Close the husk and re-dispatch headless (bsc-next --headless),
 *             where cmux surface attachment cannot bite. Capped per tick;
 *             bsc-next's deadDispatchGuard (2 recorded deaths) is the
 *             recurrence backstop.
 *   report  — dead 🤖 tab we can't map to a task (no launch entry, no task
 *             file) or whose task is in_progress (the #883 reconciler's
 *             territory — never race it). Listed, never touched.
 *
 * Only 🤖 auto-dispatched tabs are ever candidates (owner rule 2026-08-02,
 * same boundary as the no-payload reaper) — the caller pre-filters, and
 * classify() re-checks via the injected marker fn as defense in depth.
 */

const REVIVE_CAP_PER_TICK = 2; // spend safety: never fan out more than 2 headless re-dispatches per 5-min sweep

/**
 * @param {Array<{ref:string,title:string,selected?:boolean}>} deadAutoTabs
 *        dead-by-both-signals workspaces (bsc-prune's `idle` bucket).
 * @param {Array<{ref:string,title:string}>} liveWorkspaces every OTHER
 *        currently-listed workspace (for duplicate detection).
 * @param {(ref:string)=>({taskId:string|number,subject?:string}|null)} launchByRef
 * @param {(taskId:string)=>(string|null)} taskStatusById status from the
 *        shared task store, or null when the task file is missing.
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

    // Duplicate: same task already has a LIVE workspace, or an identically
    // titled live tab exists (covers launches the ledger missed).
    const isDup = (taskId && liveTaskIds.has(taskId)) || liveByTitle.has(normalizeTitle(w.title));

    if (status === 'completed' || isDup) { corpses.push({ ...entry, reason: status === 'completed' ? 'task-completed' : 'live-duplicate' }); continue; }
    if (status === 'pending') { revive.push(entry); continue; }
    // in_progress → #883 reconciler's job; unknown mapping → too little
    // evidence to close someone's tab. Both are report-only.
    report.push({ ...entry, reason: status === 'in_progress' ? 'reconciler-territory' : 'unmapped' });
  }

  return { corpses, revive: revive.slice(0, REVIVE_CAP_PER_TICK), reviveDeferred: revive.slice(REVIVE_CAP_PER_TICK), report };
}

function safeLaunch(launchByRef, ref) {
  try { return launchByRef(ref) || null; } catch { return null; }
}

// cmux truncates sidebar titles; compare on a stable prefix so a truncated
// dup ("…recover-*" vs "…recover-*-browser.js") still matches.
function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

module.exports = { classifyZombieTabs, normalizeTitle, REVIVE_CAP_PER_TICK };
