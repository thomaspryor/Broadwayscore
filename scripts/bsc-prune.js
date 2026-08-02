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
 *   bsc-prune            close every ✅-marked workspace, list idle un-marked
 *   bsc-prune --dry-run  show what would close, close nothing
 *   bsc-prune --help, -h show this message, do nothing else
 */

const {
  cmuxAvailable, listWorkspaces, isDoneTitle, claudeAliveIn, terminalSurfaceAliveIn, checkLiveness, pruneDone,
} = require('./lib/cmux-workspaces.js');
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');

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
    mainLocked({ dryRun, deps: { listWorkspacesFn, pruneDoneFn, isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn } });
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
  const { listWorkspacesFn, pruneDoneFn, isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn } = deps;

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

  const { closed, skipped, disagreements = [] } = pruneDoneFn({ dryRun });
  if (closed.length) {
    console.log(`${dryRun ? '[dry-run] would close' : 'Closed'} ${closed.length} ✅ workspace(s):`);
    closed.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  } else {
    console.log('No ✅-marked workspaces to close.');
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} ✅ workspace(s) with a live claude (running or waiting at the prompt):`);
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

  sweepVanished({ all, dryRun, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn });
}

// Task #578: reconcile launches whose workspace the owner CLOSED. Split out
// of main() so the epoch/park rules are testable without a live cmux.
function sweepVanished({ all, dryRun, readLedgerEntriesFn, appendLedgerEntryFn, parkCardFn }) {
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
  const vanished = dispatchLedger.vanishedBreadcrumbs(liveRefs, entries, { epochTs });
  if (!vanished.length) return;

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
        .vanishedBreadcrumbs(liveRefs, fresh, { epochTs })
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
  const res = spawnSync('node', [
    `${__dirname}/notion-brain.js`, 'update', vanished.notionId,
    '--status', 'Paused',
    '--outcome', `## Parked ${new Date().toISOString().slice(0, 10)}\nOwner closed its workspace (${vanished.workspaceRef}) without marking it done, so the dispatcher stopped re-opening it. Resume with \`node scripts/bsc-next.js --id ${vanished.taskId} --force\`.`,
  ], { encoding: 'utf8', timeout: 60_000 });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'notion-brain update failed').trim().split('\n').slice(-1)[0]);
}

if (require.main === module) main();

module.exports = { main, USAGE, sweepVanished, parkCard, acquireRunLock, releaseRunLock };
