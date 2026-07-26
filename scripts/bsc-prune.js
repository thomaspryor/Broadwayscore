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
  } = deps;

  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const dryRun = argv.includes('--dry-run');
  if (!cmuxAvailableFn()) {
    console.error('[bsc-prune] cmux CLI not found — is cmux.app installed?');
    process.exit(1);
  }

  const all = listWorkspacesFn();
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
  if (!dryRun) {
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
}

if (require.main === module) main();

module.exports = { main, USAGE };
