#!/usr/bin/env node
/**
 * bsc-prune — close finished Cmux workspaces.
 *
 * A finished session's wrap-up retitles its workspace with a leading ✅
 * (and self-closes; this tool is the manual sweep for sessions that died
 * before doing either). Un-marked workspaces are NEVER closed — idle ones
 * (no running claude_code process) are listed for at-a-glance review.
 *
 * Task #334 (2026-07-22): idle-unmarked workspaces are also cross-referenced
 * against the dispatch ledger (scripts/lib/dispatch-ledger.js) — a workspace
 * bsc-next.js launched that later shows up here with no live claude and no
 * ✅ died silently (the #289 >30min timeout kills a session before its Stop
 * hook can self-mark). That's the missing failure breadcrumb: this sweep
 * records it, and bsc-next.js's deadDispatchGuard refuses a further blind
 * dispatch once a task has 2 recorded deaths. The breadcrumb write is a
 * local jsonl append only — it happens even under --dry-run, since it never
 * touches cmux state (the same reason bsc-conductor's habitual
 * `bsc-prune --dry-run` orientation sweep still captures it).
 *
 * Card #856 (Session-system overhaul S3, 4b): a narrow, owner-approved
 * exception to "un-marked workspaces are NEVER closed" — a 🤖 auto-dispatched
 * (never owner-opened) workspace whose claude process is alive but stuck on
 * an auth-dead screen ("Not logged in") is neither idle (process alive) nor
 * ever going to self-mark ✅, so it would otherwise sit open forever. Two
 * consecutive sightings quarantine it (reported, not closed); the third
 * closes it and pages the owner via the digest. Kill switch:
 * NO_PAYLOAD_REAPER_DISABLED=1. See scripts/lib/no-payload-reaper.js.
 *
 *   bsc-prune            close every ✅-marked workspace, list idle un-marked
 *   bsc-prune --dry-run  show what would close, close nothing
 *   bsc-prune --help, -h show this message, do nothing else
 */

const {
  cmuxAvailable, listWorkspaces, isDoneTitle, claudeAliveIn, terminalSurfaceAliveIn, checkLiveness, pruneDone,
  closeWorkspace, run: cmuxRun,
} = require('./lib/cmux-workspaces.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { hasAutoDispatchMarker, isCrownTab } = require('./lib/prune-closeable.js');
const { screenLooksNoPayload, noPayloadReaperTick, QUARANTINE_LIMIT } = require('./lib/no-payload-reaper.js');
const { classifyZombieTabs, REVIVE_CAP_PER_TICK } = require('./lib/zombie-tab-sweep.js');

const USAGE = `bsc-prune — close finished Cmux workspaces.

Usage:
  bsc-prune            close every ✅-marked workspace, list idle un-marked
  bsc-prune --dry-run  show what would close, close nothing
  bsc-prune --help, -h show this message, do nothing else
`;

// argv + deps are test seams (defaults are the real argv + real cmux calls).
// --help/-h is checked BEFORE any cmux call (2026-07-14 incident class:
// --help must never execute the tool's real action). deps are injectable
// (not just argv) so a test can prove zero cmux calls happen for --help by
// making every dep throw, rather than trusting the guard is still correctly
// placed.
function main(argv = process.argv.slice(2), deps = {}) {
  const {
    cmuxAvailable: cmuxAvailableFn = cmuxAvailable,
    listWorkspaces: listWorkspacesFn = listWorkspaces,
    pruneDone: pruneDoneFn = pruneDone,
    isDoneTitle: isDoneTitleFn = isDoneTitle,
    claudeAliveIn: claudeAliveInFn = claudeAliveIn,
    terminalSurfaceAliveIn: surfaceAliveInFn = terminalSurfaceAliveIn,
    readLedgerEntries: readLedgerEntriesFn = dispatchLedger.readEntries,
    appendLedgerEntry: appendLedgerEntryFn = dispatchLedger.appendEntry,
    parkCard: parkCardFn = parkCard,
    acquireRunLock: acquireRunLockFn = acquireRunLock,
    releaseRunLock: releaseRunLockFn = releaseRunLock,
    readScreen: readScreenFn = (ref) => cmuxRun(['read-screen', '--workspace', ref]),
    closeWorkspace: closeWorkspaceFn = closeWorkspace,
    loadNoPayloadState: loadNoPayloadStateFn = loadNoPayloadState,
    saveNoPayloadState: saveNoPayloadStateFn = saveNoPayloadState,
    pageNoPayloadClose: pageNoPayloadCloseFn = pageNoPayloadClose,
  } = deps;

  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const dryRun = argv.includes('--dry-run');
  if (!cmuxAvailableFn()) {
    console.error('[bsc-prune] cmux CLI not found — is cmux.app installed?');
    process.exit(1);
  }

  // Single-writer lock for REAL sweeps (adversarial review, 2026-08-02): the
  // scheduled 5-min tick can now overlap an owner-run sweep, and two
  // concurrent read-decide-append passes duplicate ledger breadcrumbs and
  // Notion parks. Dry-run sweeps (bsc-conductor orientation) never take the
  // lock — they close nothing and their only write (dead breadcrumbs) is
  // idempotent per ref. Fail-open on lock I/O errors: a broken lock dir must
  // not permanently disable pruning.
  let lockHeld = false;
  if (!dryRun) {
    const acquired = acquireRunLockFn();
    if (acquired === false) { console.log('[bsc-prune] another real sweep is running — skipping this tick.'); return; }
    lockHeld = acquired === true;
  }
  try {
    mainLocked({ dryRun, deps: { listWorkspacesFn, pruneDoneFn, isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn, readScreenFn, closeWorkspaceFn, loadNoPayloadStateFn, saveNoPayloadStateFn, pageNoPayloadCloseFn } });
  } finally {
    if (lockHeld) releaseRunLockFn();
  }
}

const LOCK_DIR = path.join(__dirname, '..', 'data', 'audit', 'bsc-prune.lock');
const LOCK_STALE_MS = 4 * 60 * 1000; // < the 5-min tick, so a crashed run self-heals by the next one

// Returns true (acquired), false (fresh lock held elsewhere), or 'error'
// (lock machinery broken — proceed unlocked rather than never pruning).
function acquireRunLock(lockDir = LOCK_DIR, staleMs = LOCK_STALE_MS) {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return 'error';
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(lockDir, 'meta.json'), 'utf8'));
      if (Date.now() - meta.ts < staleMs) return false;
      // Stale: previous run crashed without releasing. Take over.
      fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return true;
    } catch { return 'error'; }
  }
}

function releaseRunLock(lockDir = LOCK_DIR) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* next run's staleness check recovers */ }
}

function mainLocked({ dryRun, deps }) {
  const { listWorkspacesFn, pruneDoneFn, isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn, readScreenFn, closeWorkspaceFn, loadNoPayloadStateFn, saveNoPayloadStateFn, pageNoPayloadCloseFn } = deps;

  const all = listWorkspacesFn();

  // Task #578: journal a per-ref terminal entry for every ✅-marked workspace
  // BEFORE pruneDone closes it. The aggregate {event:'prune', taskId:'sweep'}
  // line below records only a COUNT, so a closed-because-finished workspace
  // was indistinguishable from one the owner closed by hand — and the
  // vanished sweep would have parked its card. Ordering matches
  // failedLaunchEntries' doctrine: terminal first, so a concurrent sweep
  // landing between this write and the close still sees a reconciled ref.
  // Entries are written for ✅ workspaces pruneDone may go on to SKIP (live
  // claude); that is the safe direction — a ✅ workspace must never park.
  //
  // ACCEPTED TRADEOFF (ship-check, Codex): writing before the close means a
  // ✅ workspace that pruneDone skips is marked reconciled for its CURRENT
  // launch. If its ✅ were later removed and work resumed under that same
  // launch, an owner close would not park it. Narrow (requires un-✅-ing a
  // marked-done tab) and self-correcting on the next dispatch, since the
  // terminal check compares against the LAST launch's ts — a re-dispatch
  // makes the ref parkable again. Writing after the close instead would
  // reopen the wider race this ordering exists to prevent: a concurrent
  // sweep seeing a closed, absent, unreconciled ref and parking finished work.
  let entriesBeforePrune;
  try { entriesBeforePrune = readLedgerEntriesFn(); } catch { entriesBeforePrune = []; }
  if (!dryRun) {
    for (const w of all.filter(w => isDoneTitleFn(w.title))) {
      const entry = dispatchLedger.pruneClosedEntry(w, entriesBeforePrune);
      if (!entry) continue;
      try { appendLedgerEntryFn(entry); }
      catch (e) { console.error(`[bsc-prune] WARN prune-closed write failed for ${w.ref} (non-fatal): ${e.message}`); }
    }
  }

  // readLedgerEntries threaded through (Codex adversarial review, 2026-08-03,
  // card #971): pruneDone's own ledger-trust check (isLedgerAutoDispatched)
  // needs the SAME injectable read this file already uses for the
  // prune-closed pre-write above — leaving it defaulted meant a real run read
  // the ledger file twice (harmless but wasteful) and a test injecting a fake
  // readLedgerEntriesFn here silently would NOT reach pruneDone's own check.
  const { closed, skipped, disagreements = [] } = pruneDoneFn({ dryRun, readLedgerEntries: readLedgerEntriesFn });
  if (closed.length) {
    console.log(`${dryRun ? '[dry-run] would close' : 'Closed'} ${closed.length} ✅ workspace(s):`);
    closed.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  } else {
    console.log('No ✅-marked workspaces to close.');
  }
  if (skipped.length) {
    // Owner rule 2026-08-02: skipped now mixes two hands-off classes — live
    // (mid-turn/selected) tabs AND owner-opened non-🤖 ✅ tabs (even fully
    // dead). Don't claim liveness for all of them; that misled the owner
    // about which tabs were safe to hand-close.
    console.log(`Skipped ${skipped.length} ✅ workspace(s) (mid-turn, selected, or owner-opened — hands-off by design; close by hand if done):`);
    skipped.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  }
  // Card #564 follow-up: a non-empty disagreements list is direct evidence of
  // the cmux tag/process registry desyncing from the terminal-surface
  // registry in PRODUCTION (#548/#559), not just a hypothetical this fix
  // guards against — worth flagging loudly, not just silently skipping.
  if (disagreements.length) {
    console.log(`\n⚠ Registry desync detected: ${disagreements.length} workspace(s) where claudeAliveIn() said dead but the terminal-surface signal said alive (would have been WRONGLY closed without the #559 fix):`);
    disagreements.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  }

  // Journal the sweep (S4-T3) so the morning email can say "Closed N finished
  // tabs" — the owner sees the workspace count drop overnight and otherwise
  // has no record of who closed what. Never fatal: a ledger write failure must
  // not fail a sweep that already did its real work.
  // Skip the write when the sweep was a NO-OP (nothing closed or skipped):
  // the scheduled auto-prune tick (owner escalation 2026-08-02) runs every
  // 5 min, and an unconditional write would add ~288 empty lines/day to the
  // ledger for zero digest value (autonomous-email sums `closed`, so no-op
  // entries contribute nothing).
  if (!dryRun && (closed.length || skipped.length)) {
    try { appendLedgerEntryFn({ event: 'prune', taskId: 'sweep', closed: closed.length, skipped: skipped.length }); }
    catch (e) { console.error(`[bsc-prune] WARN dispatch-ledger prune write failed (non-fatal): ${e.message}`); }
  }

  const closedRefs = new Set(closed.map(w => w.ref));
  // Card #564 follow-up (adversarial ship-check catch): this idle-unmarked
  // listing feeds dispatchLedger.deadBreadcrumbs() below, which writes 'dead'
  // ledger entries that bsc-next's deadDispatchGuard reads — the EXACT same
  // duplicate-dispatch guard checkDeadDispatch feeds. Trusting claudeAliveInFn
  // alone here would reopen the #559/#564 registry-desync false-negative in a
  // fourth call site right next to the three already fixed. Both signals must
  // agree before a workspace counts as dead here too.
  const idleDisagreements = [];
  const idle = all
    .filter(w => !closedRefs.has(w.ref) && !isDoneTitleFn(w.title))
    .filter(w => {
      const { dead, disagreement } = checkLiveness(w.ref, claudeAliveInFn, surfaceAliveInFn);
      if (disagreement) idleDisagreements.push(w);
      return dead;
    });
  if (idleDisagreements.length) {
    console.log(`\n⚠ Registry desync detected: ${idleDisagreements.length} idle-unmarked workspace(s) where claudeAliveIn() said dead but the terminal-surface signal said alive (would have gotten a WRONG dead-dispatch breadcrumb without the #564 fix):`);
    idleDisagreements.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  }
  if (idle.length) {
    console.log(`\nDead but un-marked (no claude process at all — NOT closed, review yourself):`);
    let ledgerEntries;
    try { ledgerEntries = readLedgerEntriesFn(); } catch { ledgerEntries = []; }
    idle.forEach(w => {
      const launch = dispatchLedger.launchByRef(w.ref, ledgerEntries);
      const label = launch ? ` — died mid task #${launch.taskId} "${launch.subject}"` : '';
      console.log(`  ${w.ref}  ${w.title}${label}`);
    });

    // Journal the failure breadcrumb (task #334): the ONLY thing this writes
    // is a local jsonl line — it never closes or touches the workspace, so
    // it's safe to record even under --dry-run (bsc-conductor's orientation
    // sweep only ever runs --dry-run, and it should still see this).
    const breadcrumbs = dispatchLedger.deadBreadcrumbs(idle, ledgerEntries);
    if (breadcrumbs.length) {
      breadcrumbs.forEach(b => { try { appendLedgerEntryFn(b); } catch (e) { console.error(`[bsc-prune] WARN dispatch-ledger write failed for ${b.workspaceRef}: ${e.message}`); } });
      console.log(`\nRecorded ${breadcrumbs.length} new dead-dispatch breadcrumb(s) in dispatch-ledger.jsonl:`);
      breadcrumbs.forEach(b => console.log(`  ${b.workspaceRef}  task #${b.taskId} "${b.subject}"`));
    }
  }

  // Zombie-tab sweep (owner escalations 2026-08-02/03 — "tabs stuck not
  // started until I click into them"): cmux sometimes creates a workspace
  // whose surface never attaches to a window (in_window=false), so the
  // launch command never executes. Acts ONLY on the `idle` bucket (dead by
  // BOTH liveness signals) further filtered to 🤖 auto-dispatched tabs, and
  // only when the task store gives a decisive answer: completed/duplicate →
  // corpse (close), pending → never booted (close + re-dispatch headless,
  // where surface attachment cannot bite). in_progress stays with the #883
  // reconciler; unmapped tabs are report-only. The idle bucket's dead
  // breadcrumbs above are terminal ledger entries, so these closes can never
  // be mistaken for owner closes by sweepVanished; revival recurrence is
  // capped by an explicit deadAttemptsForTask check inside the sweep (the
  // --headless path never reaches bsc-next's own deadDispatchGuard).
  sweepZombieTabs({
    all, idle, dryRun,
    closeWorkspaceFn, appendLedgerEntryFn, readLedgerEntriesFn,
  });

  // No-payload reaper (card #856, Session-system overhaul S3, 4b): distinct
  // from the idle-unmarked listing above (which only ever catches a DEAD
  // claude process) — this catches an ALIVE 🤖 auto-dispatched workspace
  // stuck on an auth-dead screen ("Not logged in") that will otherwise sit
  // open forever, since it's neither idle nor ever going to self-mark ✅.
  // idle's refs are dead-process by definition and never candidates here.
  const idleRefs = new Set(idle.map(w => w.ref));
  sweepNoPayload({
    all, closedRefs, idleRefs, dryRun,
    isDoneTitleFn, readScreenFn, closeWorkspaceFn,
    loadNoPayloadStateFn, saveNoPayloadStateFn, pageNoPayloadCloseFn,
    readLedgerEntriesFn, appendLedgerEntryFn,
  });

  sweepVanished({ all, dryRun, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn });
}

// Machine-local state (never git-tracked — same convention as
// context-budget-nudge.sh's ~/.claude/state/statusline/ files): per-ref
// consecutive no-payload sighting counts, persisted across sweep ticks.
const NO_PAYLOAD_STATE_PATH = path.join(os.homedir(), '.claude', 'state', 'no-payload-reaper.json');

function loadNoPayloadState(p = NO_PAYLOAD_STATE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; } // missing/corrupt — fail open to "nothing quarantined yet"
}

function saveNoPayloadState(state, p = NO_PAYLOAD_STATE_PATH) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  } catch (e) { console.error(`[no-payload] WARN state write failed (non-fatal, next tick re-quarantines from 0): ${e.message}`); }
}

// Best-effort digest page when the reaper actually closes a workspace (card
// #856) — a real behavior change from "nothing auto-closes an unmarked tab"
// (feedback_never_close_unmarked_cmux_workspaces.md), so every close must be
// loud and auditable, never silent. Never lets an alerting failure mask the
// close already performed.
function pageNoPayloadClose(observation, launch) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    const taskLabel = launch ? ` (task #${launch.taskId} "${launch.subject}")` : '';
    routeAlert({
      conditionKey: `bsc-prune:no-payload-close:${observation.ref}`,
      title: `Closed a no-payload workspace — ${observation.ref}`,
      description: `${observation.title}${taskLabel} sat on an auth-dead screen for ${QUARANTINE_LIMIT + 1} consecutive sweeps with no output, then was closed by bsc-prune's no-payload reaper. If this was real work, re-check claude auth and re-dispatch${launch ? `: node scripts/bsc-next.js --id ${launch.taskId} --force` : ''}.`,
      severity: 'warning',
      disposition: 'digest',
      cooldownHours: 1,
    }).catch(() => {});
  } catch { /* alerting must never block the close already performed */ }
}

// Card #856, 4b. Owner rule 2026-08-02 ("auto-close is limited to 🤖
// auto-dispatched tabs, full stop" — prune-closeable.js's isCloseable)
// governs the candidate filter here too: never the selected tab, never a
// ✅-marked or already-closed-this-sweep ref, never a dead-process ref
// (that's the pre-existing idle-unmarked bucket's job), and never a tab
// without the 🤖 marker — an owner-opened tab is NEVER a candidate,
// regardless of what its screen shows. Kill switch matches the
// DEPLOY_GATE_DISABLED pattern (default OFF — reaper active — until this
// soaks).
function sweepNoPayload({ all, closedRefs, idleRefs, dryRun, isDoneTitleFn, readScreenFn, closeWorkspaceFn, loadNoPayloadStateFn, saveNoPayloadStateFn, pageNoPayloadCloseFn, readLedgerEntriesFn, appendLedgerEntryFn }) {
  if (process.env.NO_PAYLOAD_REAPER_DISABLED === '1') return;

  // …and never a crown (owner-loop) tab, task #1751. This is the THIRD close
  // path in this file — pruneDone's isCloseable and sweepZombieTabs's
  // classifyZombieTabs are the other two, and both got the crown veto first.
  // This one is reached by a DIFFERENT route (screen CONTENTS, not process
  // liveness), so it needs its own check: an owner loop parked at an empty
  // prompt reads exactly like a no-payload husk.
  const candidates = all.filter(w =>
    !closedRefs.has(w.ref) && !idleRefs.has(w.ref) && !isDoneTitleFn(w.title) && !w.selected
    && hasAutoDispatchMarker(w.title) && !isCrownTab(w.title)
  );
  if (!candidates.length) return;

  const observations = candidates.map(w => {
    let screenText = '';
    try { screenText = readScreenFn(w.ref); } catch { /* read failure — never flag on uncertainty */ }
    return { ref: w.ref, title: w.title, noPayload: screenLooksNoPayload(screenText) };
  });

  const priorState = loadNoPayloadStateFn();
  const { toClose, toQuarantine, state } = noPayloadReaperTick(observations, priorState);

  if (toQuarantine.length) {
    console.log(`\n[no-payload] ${toQuarantine.length} 🤖 workspace(s) showing no payload (auth-dead pane), quarantined:`);
    toQuarantine.forEach(o => console.log(`  ${o.ref}  ${o.title}  (sighting ${o.count}/${QUARANTINE_LIMIT})`));
  }

  if (dryRun) {
    if (toClose.length) {
      console.log(`\n[dry-run] would close ${toClose.length} no-payload workspace(s) (${QUARANTINE_LIMIT + 1} consecutive sightings):`);
      toClose.forEach(o => console.log(`  ${o.ref}  ${o.title}`));
    }
    return; // never persist state or touch cmux under --dry-run
  }

  saveNoPayloadStateFn(state);
  if (!toClose.length) return;

  console.log(`\n[no-payload] closing ${toClose.length} workspace(s) that never produced output (${QUARANTINE_LIMIT + 1} consecutive auth-dead sightings):`);
  let ledgerEntries;
  try { ledgerEntries = readLedgerEntriesFn(); } catch { ledgerEntries = []; }
  for (const o of toClose) {
    // Hard safety at the close SITE, not just the candidate filter (reviewer
    // catch, task #1751): the filter above stops crown tabs being observed at
    // all today, but toClose is also fed from `priorState`, and a future
    // refactor or a new observation source could route one here. A crown tab
    // is never closed by this reaper, whatever it looks like on screen.
    if (isCrownTab(o.title)) { console.log(`  ${o.ref}  ${o.title}  — crown tab, left alone`); continue; }
    console.log(`  ${o.ref}  ${o.title}`);
    try { closeWorkspaceFn(o.ref); } catch (e) { console.error(`[no-payload] WARN close failed for ${o.ref}: ${e.message}`); }
    const launch = dispatchLedger.launchByRef(o.ref, ledgerEntries);
    try { appendLedgerEntryFn({ event: 'dead', taskId: (launch && launch.taskId) || 'unknown', workspaceRef: o.ref, reason: 'no-payload' }); }
    catch (e) { console.error(`[no-payload] WARN ledger write failed for ${o.ref}: ${e.message}`); }
    pageNoPayloadCloseFn(o, launch);
  }
}

// Zombie-tab sweep I/O half (decision logic lives in lib/zombie-tab-sweep.js).
// Kill switch: ZOMBIE_TAB_SWEEP_DISABLED=1 (DEPLOY_GATE_DISABLED pattern).
const ZOMBIE_TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');

// Live dir first, archive/ fallback — completed tasks get archived (task
// #854), and without the fallback an archived-completed corpse would read as
// "unmapped" and sit in the sidebar forever (Codex catch).
function taskStatusById(taskId, dir = ZOMBIE_TASKS_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${taskId}.json`), 'utf8')).status || null; }
  catch { /* fall through to archive */ }
  const { readArchivedTask } = require('./lib/task-store-archive.js');
  const archived = readArchivedTask(dir, taskId);
  return (archived && archived.status) || null;
}

function sweepZombieTabs({ all, idle, dryRun, closeWorkspaceFn, appendLedgerEntryFn, readLedgerEntriesFn, taskStatusByIdFn = taskStatusById, redispatchFn = redispatchHeadless, pageFn = pageZombieSweep }) {
  if (process.env.ZOMBIE_TAB_SWEEP_DISABLED === '1') return;

  const idleRefs = new Set(idle.map(w => w.ref));
  const deadAutoTabs = idle.filter(w => hasAutoDispatchMarker(w.title));
  if (!deadAutoTabs.length) return;

  let entries;
  try { entries = readLedgerEntriesFn(); } catch { entries = []; }
  // dispatchLedger.launchByRef is last-match (card #960) — cmux recycles
  // workspace refs across restarts, so first-match could close/redispatch
  // the wrong, long-gone task's tab.
  const { corpses, revive, report } = classifyZombieTabs({
    deadAutoTabs,
    liveWorkspaces: all.filter(w => !idleRefs.has(w.ref)),
    launchByRef: (ref) => dispatchLedger.launchByRef(ref, entries),
    taskStatusById: taskStatusByIdFn,
    hasAutoDispatchMarker,
  });

  if (report.length) {
    console.log(`\n[zombie-sweep] ${report.length} dead 🤖 tab(s) left alone (${report.map(r => `${r.ref} ${r.reason}`).join(', ')})`);
  }
  if (!corpses.length && !revive.length) return;

  // Recurrence guard BEFORE the fan-out cap (ship-check catch: a guarded
  // task in a cap slot starved a revivable one for a tick). The guard must
  // live HERE: bsc-next's --headless branch returns before its own
  // deadDispatchGuard ever runs (second-opinion catch — the guard is only
  // wired into the cmux dispatch path). The idle bucket wrote this tick's
  // 'dead' breadcrumbs before this point, so the fresh count already
  // includes this death: a tab that zombies twice stops being revived.
  const freshEntries = entriesAfterBreadcrumbs(readLedgerEntriesFn, entries);
  const guarded = [];
  const revivable = [];
  for (const r of revive) {
    // Card #1233: this path bypasses bsc-next's deadDispatchGuard entirely
    // (headless dispatch never reaches it — see the comment above), so it
    // needs its own correct infra-vs-substantive cap, not just a count of
    // every dead-class entry.
    const cap = dispatchLedger.dispatchCapDecision(r.taskId, freshEntries);
    (cap.blocked ? guarded : revivable).push({
      ...r,
      deaths: cap.reason === 'infra' ? cap.infra.length : cap.substantive.length,
      reason: cap.reason,
    });
  }
  const toRevive = revivable.slice(0, REVIVE_CAP_PER_TICK);
  const deferred = revivable.slice(REVIVE_CAP_PER_TICK);

  if (dryRun) {
    corpses.forEach(c => console.log(`[dry-run][zombie-sweep] would close corpse ${c.ref} "${c.title}" (${c.reason})`));
    guarded.forEach(g => console.log(`[dry-run][zombie-sweep] would close guarded husk ${g.ref} task #${g.taskId} (${g.reason === 'infra' ? `failed to boot ${g.deaths}x in a row` : `died ${g.deaths}x`}, no re-dispatch)`));
    toRevive.forEach(r => console.log(`[dry-run][zombie-sweep] would close + re-dispatch headless ${r.ref} task #${r.taskId}`));
    return;
  }

  for (const c of corpses) {
    console.log(`[zombie-sweep] closing corpse ${c.ref} "${c.title}" (${c.reason})`);
    try { closeWorkspaceFn(c.ref); } catch (e) { console.error(`[zombie-sweep] WARN close failed for ${c.ref}: ${e.message}`); continue; }
    try { appendLedgerEntryFn({ event: 'prune-closed', taskId: c.taskId || 'unknown', subject: c.subject || null, title: c.title, workspaceRef: c.ref, reason: `zombie-${c.reason}` }); }
    catch (e) { console.error(`[zombie-sweep] WARN ledger write failed for ${c.ref}: ${e.message}`); }
  }

  const guardedClosed = [];
  for (const g of guarded) {
    console.log(`[zombie-sweep] task #${g.taskId} has ${g.reason === 'infra' ? `failed to boot ${g.deaths}x in a row` : `died ${g.deaths}x`} — closing husk ${g.ref} but NOT re-dispatching (deadDispatchGuard threshold); paged to digest`);
    try { closeWorkspaceFn(g.ref); } catch (e) { console.error(`[zombie-sweep] WARN close failed for ${g.ref}: ${e.message}`); continue; }
    guardedClosed.push(g);
  }

  const revived = [];
  for (const r of toRevive) {
    console.log(`[zombie-sweep] never-booted launch ${r.ref} task #${r.taskId} — closing husk and re-dispatching headless`);
    // Close must succeed BEFORE the re-dispatch: a transient close failure
    // with a dispatch anyway runs the task twice concurrently (QA + Codex
    // catch — the exact failure class this feature routes around).
    try { closeWorkspaceFn(r.ref); }
    catch (e) { console.error(`[zombie-sweep] WARN close failed for ${r.ref} — NOT re-dispatching this tick: ${e.message}`); continue; }
    redispatchFn(r.taskId);
    revived.push(r);
  }
  if (deferred.length) console.log(`[zombie-sweep] ${deferred.length} more never-booted tab(s) deferred to the next tick (per-tick cap)`);

  pageFn({ corpses, revive: revived, guarded: guardedClosed });
}

// Fresh entries so the death count includes THIS tick's idle-bucket
// breadcrumbs; falls back to the sweep's earlier snapshot on read failure.
function entriesAfterBreadcrumbs(readLedgerEntriesFn, snapshot) {
  try { return readLedgerEntriesFn(); } catch { return snapshot; }
}

// Fire-and-forget: the sweep runs under the 4-min-stale run lock, so a
// synchronous wait here (2 revives x 120s worst case, second-opinion catch)
// could outlive the lock and let the next tick start a concurrent sweep.
// bsc-next --headless hands off to bsc-runner and exits on its own; output
// goes to a per-task log under data/audit/headless-logs/ for the audit trail.
function redispatchHeadless(taskId) {
  const { spawn } = require('child_process');
  const logDir = path.join(__dirname, '..', 'data', 'audit', 'headless-logs');
  let out = 'ignore';
  try { fs.mkdirSync(logDir, { recursive: true }); out = fs.openSync(path.join(logDir, `zombie-redispatch-${taskId}.log`), 'a'); } catch { /* log loss never blocks the dispatch */ }
  const child = spawn('node', [path.join(__dirname, 'bsc-next.js'), '--id', String(taskId), '--headless'], { detached: true, stdio: ['ignore', out, out] });
  child.on('error', (e) => console.error(`[zombie-sweep] re-dispatch #${taskId} spawn error: ${e.message} — task stays pending, surfaces via bsc-next --list`));
  child.unref();
  if (out !== 'ignore') { try { fs.closeSync(out); } catch { /* child holds its own fd */ } }
  console.log(`[zombie-sweep] re-dispatch #${taskId} spawned detached (log: data/audit/headless-logs/zombie-redispatch-${taskId}.log)`);
}

// Digest page — every auto-close of an unmarked tab must be loud and
// auditable, same doctrine as pageNoPayloadClose. Per-event conditionKeys
// (matching that sibling), NOT one static key: a static key's 1h cooldown
// would silently swallow the second batch of closes during exactly the
// mass-outage scenario this sweep exists for (second-opinion catch). The
// taskId is in the key because cmux recycles refs — a recycled ref's fresh
// incident within the cooldown must not be swallowed either (Codex catch).
function pageZombieSweep({ corpses, revive, guarded = [] }) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    const events = [
      ...corpses.map(c => ({ ref: c.ref, taskId: c.taskId, severity: 'info', line: `closed corpse ${c.ref} "${c.title}" (${c.reason})` })),
      ...revive.map(r => ({ ref: r.ref, taskId: r.taskId, severity: 'info', line: `closed never-booted ${r.ref}, re-dispatched task #${r.taskId} headless` })),
      // Guard-threshold closes are the one bucket that NEEDS a human — a
      // task that keeps dying with no more automatic retries (QA catch:
      // these were console-only before). Warning severity, not info.
      ...guarded.map(g => ({ ref: g.ref, taskId: g.taskId, severity: 'warning', line: `closed ${g.ref} for task #${g.taskId} which has ${g.reason === 'infra' ? `failed to boot ${g.deaths}x in a row (cmux itself looks wedged)` : `died ${g.deaths}x`} — automatic revival stopped (deadDispatchGuard threshold). Investigate, then re-dispatch with: node scripts/bsc-next.js --id ${g.taskId} --force` })),
    ];
    for (const e of events) {
      routeAlert({
        conditionKey: `bsc-prune:zombie-sweep:${e.ref}:${e.taskId || 'unknown'}`,
        title: `Zombie-tab sweep closed ${e.ref}`,
        description: e.line,
        severity: e.severity,
        disposition: 'digest',
        cooldownHours: 1,
      }).catch(() => {});
    }
  } catch { /* alerting must never block the sweep */ }
}

// Task #578: reconcile launches whose workspace the owner CLOSED. Split out
// of main() so the epoch/park rules are testable without a live cmux.
function sweepVanished({ all, dryRun, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn, now = Date.now() }) {
  let entries;
  try { entries = readLedgerEntriesFn(); } catch { entries = []; }

  // First run on a machine records the epoch and parks nothing: every launch
  // already in the ledger predates it. Without this the first sweep would
  // park ~150 historical cards, most of which closed because they finished.
  let epochTs = dispatchLedger.vanishEpoch(entries);
  if (!epochTs) {
    if (dryRun) {
      console.log('\n[vanished] no epoch recorded yet — first non-dry-run sweep will set it and park nothing.');
      return;
    }
    try {
      const stamped = appendLedgerEntryFn(dispatchLedger.vanishEpochEntry());
      epochTs = stamped && stamped.ts;
      console.log(`\n[vanished] recorded tab-close epoch ${epochTs} — only launches after this can park.`);
    } catch (e) {
      console.error(`[bsc-prune] WARN vanish-epoch write failed (non-fatal): ${e.message}`);
      return;
    }
    entries = entries.concat([{ event: 'vanish-epoch', ts: epochTs, taskId: 'epoch' }]);
  }

  const liveRefs = new Set(all.map(w => w.ref));
  const candidates = dispatchLedger.vanishedBreadcrumbs(liveRefs, entries, { epochTs, now });
  if (!candidates.length) return;

  // Task #883: a cmux restart renumbers every open workspace ref at once, so
  // "not in the current listing" cannot by itself tell a renumbering apart
  // from the owner closing every one of those tabs by hand in the same
  // 5-minute tick (owner report 2026-08-03 — #853 was parked this way and
  // needed --force). First defense: the SAME session is often still listed,
  // just under a new ref — find it by title and remap instead of parking.
  const claimedRefs = new Set();
  const renumbered = [];
  const unmatched = [];
  for (const v of candidates) {
    const match = dispatchLedger.findRenumberedWorkspace(v, all, claimedRefs);
    if (match) { claimedRefs.add(match.ref); renumbered.push({ v, match }); }
    else unmatched.push(v);
  }

  if (renumbered.length) {
    console.log(`\nRenumbered (cmux restart, same session under a new ref) — remapping ${renumbered.length}, not parking:`);
    for (const { v, match } of renumbered) {
      console.log(`  ${v.workspaceRef} → ${match.ref}  task #${v.taskId} "${v.subject}"`);
      if (dryRun) continue;
      // Carry forward model/verifyCmd/verifyReason from the ORIGINAL launch
      // (ship-check catch, 2026-08-03) — vanishedBreadcrumbs' candidate
      // shape drops those fields, and without them the nightly acceptance
      // recheck silently treats a remapped card as unverifiable. Card #960:
      // launchByRef is last-match, and `entries` hasn't gained a newer launch
      // for this ref since vanishedBreadcrumbs computed `v` (also last-match)
      // above, so this resolves to the SAME launch record `v` came from —
      // not some earlier, recycled-ref occupant of v.workspaceRef.
      const orig = dispatchLedger.launchByRef(v.workspaceRef, entries);
      const [oldTerminal, newLaunch] = dispatchLedger.remapEntries({
        taskId: v.taskId, subject: v.subject, oldRef: v.workspaceRef, newRef: match.ref,
        notionId: v.notionId || null,
        model: (orig && orig.model) || null,
        verifyCmd: (orig && orig.verifyCmd) || null,
        verifyReason: (orig && orig.verifyReason) || null,
      });
      // Old ref's terminal entry FIRST (see remapEntries' header comment for
      // why order matters here, same as failedLaunchEntries above).
      try { appendLedgerEntryFn(oldTerminal); appendLedgerEntryFn(newLaunch); }
      catch (e) { console.error(`[bsc-prune] WARN remap write failed for ${v.workspaceRef}→${match.ref}: ${e.message}`); }
    }
  }

  if (!unmatched.length) return;

  // Second defense: even with no title hit (a mid-render surface at the
  // exact sweep moment, a manual rename), a large fraction of currently-
  // tracked launches vanishing in the SAME sweep is a renumbering event
  // still stabilizing, never that many individual owner closes landing in
  // one 5-minute tick. Ratio uses the ORIGINAL candidate count (not the
  // post-remap remainder) — that's the true churn magnitude for this sweep.
  const totalOpen = dispatchLedger.openWorkspaceLaunchCount(entries, { epochTs, now });
  if (dispatchLedger.looksLikeRestart(candidates.length, totalOpen)) {
    // Bounded hold (ship-check P0 catch, 2026-08-03): a GENUINE mass-close
    // (the owner closes 3+ tabs in one pass, none renumbered) never shrinks
    // this ratio on its own — without a cap this branch would withhold
    // parking on every future sweep forever, regressing #578 for exactly
    // the cards it exists to park. "sameIncident" (any overlap with the
    // LAST hold's recorded refs) is what lets a fresh, unrelated restart
    // start its own 15-min clock instead of inheriting a stale timestamp
    // from an incident that resolved days ago; the hold entry is written
    // only ONCE per incident (age is measured from first detection, not
    // re-stamped every tick, or it would never expire).
    const unmatchedRefs = unmatched.map(v => v.workspaceRef);
    const hold = dispatchLedger.lastRestartHold(entries);
    const sameIncident = !!(hold && Array.isArray(hold.refs) && hold.refs.some(r => unmatchedRefs.includes(r)));
    const holdAgeMs = sameIncident && hold.ts ? Date.now() - Date.parse(hold.ts) : 0;
    if (!sameIncident || holdAgeMs < dispatchLedger.RESTART_HOLD_MAX_MS) {
      if (!sameIncident && !dryRun) {
        try { appendLedgerEntryFn(dispatchLedger.restartHoldEntry(unmatchedRefs)); }
        catch (e) { console.error(`[bsc-prune] WARN restart-hold write failed (non-fatal): ${e.message}`); }
      }
      console.log(`\n[vanished] ${candidates.length}/${totalOpen} tracked tab(s) vanished in one sweep — looks like a cmux restart, not ${candidates.length} individual closes. Holding off on parking ${unmatched.length} unmatched card(s) this tick (up to ${Math.round(dispatchLedger.RESTART_HOLD_MAX_MS / 60000)}min); will re-check next sweep.`);
      return;
    }
    console.log(`\n[vanished] restart-hold window (${Math.round(holdAgeMs / 60000)}min) elapsed with no resolution — proceeding to park ${unmatched.length} card(s) despite the mass-vanish ratio (likely a genuine mass-close, not a restart).`);
  }

  const vanished = unmatched;
  console.log(`\nClosed by you — parking ${vanished.length} card(s) so nothing re-dispatches them:`);
  vanished.forEach(v => console.log(`  ${v.workspaceRef}  task #${v.taskId} "${v.subject}"`));
  if (dryRun) { console.log('  [dry-run] no ledger write, no Notion update'); return; }

  for (const v of vanished) {
    // Re-read and re-validate immediately before the append (ship-check P0,
    // Codex). The candidate list above is a SNAPSHOT: between computing it and
    // appending, bsc-next can dispatch this same task and append its own
    // 'launch'. Our stale 'vanished' would then land AFTER that launch, and
    // parkedTasks() — which replays in file order — would park a workspace the
    // owner is actively working in. Re-deriving from fresh entries and keeping
    // only refs that are still candidates closes the window to the width of a
    // single appendFileSync. Also makes two concurrent prune runs idempotent:
    // the second sees the first's 'vanished' as a terminal entry and drops it.
    let stillVanished;
    try {
      const fresh = readLedgerEntriesFn();
      stillVanished = dispatchLedger
        .vanishedBreadcrumbs(liveRefs, fresh, { epochTs, now })
        .some(f => f.workspaceRef === v.workspaceRef);
    } catch (e) {
      console.error(`[bsc-prune] WARN re-validate failed for ${v.workspaceRef}, skipping park: ${e.message}`);
      continue; // fail closed — never park on a stale read
    }
    if (!stillVanished) {
      console.log(`  ${v.workspaceRef} re-dispatched or already reconciled since the scan — not parking`);
      continue;
    }
    // Ledger first: the park must hold even if Notion is unreachable. The
    // ledger is what bsc-next actually gates on; the Notion status is the
    // owner-visible mirror of it.
    try { appendLedgerEntryFn(v); }
    catch (e) { console.error(`[bsc-prune] WARN vanished write failed for ${v.workspaceRef}: ${e.message}`); continue; }
    if (!v.notionId) continue;
    try { parkCardFn(v); }
    catch (e) { console.error(`[bsc-prune] WARN Notion park failed for #${v.taskId} (ledger park still holds): ${e.message}`); }
  }
  console.log(`\nTo resume any of them: node scripts/bsc-next.js --id <task#> --force`);
}

// Notion side-effect lives HERE, in the caller, never in the ledger lib —
// every other decision in this subsystem is a pure function with its I/O in
// bsc-prune/bsc-next (checkDeadDispatch returns breadcrumbs, main() appends).
// --outcome PREPENDS (notion-brain.js:691); --notes would overwrite the whole
// card body, and --note is silently dropped.
function parkCard(vanished) {
  const { spawnSync } = require('child_process');
  // The `## Parked <date>` header is a machine-parsed contract — stuck-work.js
  // keys its pausedParked bucket on it. Always build it via park-marker.js.
  const { formatParkOutcome } = require('./lib/park-marker.js');
  const res = spawnSync('node', [
    `${__dirname}/notion-brain.js`, 'update', vanished.notionId,
    '--status', 'Paused',
    '--outcome', formatParkOutcome({ dateStr: new Date().toISOString().slice(0, 10), workspaceRef: vanished.workspaceRef, taskId: vanished.taskId }),
  ], { encoding: 'utf8', timeout: 60_000 });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'notion-brain update failed').trim().split('\n').slice(-1)[0]);
}

if (require.main === module) main();

module.exports = { main, USAGE, sweepVanished, parkCard, acquireRunLock, releaseRunLock, sweepNoPayload, loadNoPayloadState, saveNoPayloadState, pageNoPayloadClose, NO_PAYLOAD_STATE_PATH, sweepZombieTabs, taskStatusById };
