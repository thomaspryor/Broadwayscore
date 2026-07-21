#!/usr/bin/env node
/**
 * bsc-prune — close finished Cmux workspaces.
 *
 * A finished session's wrap-up retitles its workspace with a leading ✅
 * (and self-closes; this tool is the manual sweep for sessions that died
 * before doing either). Un-marked workspaces are NEVER closed — idle ones
 * (no running claude_code process) are listed for at-a-glance review.
 *
 *   bsc-prune            close every ✅-marked workspace, list idle un-marked
 *   bsc-prune --dry-run  show what would close, close nothing
 *   bsc-prune --help, -h show this message, do nothing else
 */

const {
  cmuxAvailable, listWorkspaces, isDoneTitle, claudeRunningIn, pruneDone,
} = require('./lib/cmux-workspaces.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `bsc-prune — close finished Cmux workspaces.

Usage:
  bsc-prune            close every ✅-marked workspace, list idle un-marked
  bsc-prune --dry-run  show what would close, close nothing
  bsc-prune --help, -h show this message, do nothing else
`;

// argv is a test seam (default is the real argv). --help/-h is checked
// BEFORE any cmux call (2026-07-14 incident class: --help must never execute
// the tool's real action).
function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const dryRun = argv.includes('--dry-run');
  if (!cmuxAvailable()) {
    console.error('[bsc-prune] cmux CLI not found — is cmux.app installed?');
    process.exit(1);
  }

  const all = listWorkspaces();
  const { closed, skipped } = pruneDone({ dryRun });
  if (closed.length) {
    console.log(`${dryRun ? '[dry-run] would close' : 'Closed'} ${closed.length} ✅ workspace(s):`);
    closed.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  } else {
    console.log('No ✅-marked workspaces to close.');
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} ✅ workspace(s) with claude still running (finishing wrap-up?):`);
    skipped.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  }

  const closedRefs = new Set(closed.map(w => w.ref));
  const idle = all
    .filter(w => !closedRefs.has(w.ref) && !isDoneTitle(w.title))
    .filter(w => !claudeRunningIn(w.ref));
  if (idle.length) {
    console.log(`\nIdle but un-marked (no running claude — NOT closed, review yourself):`);
    idle.forEach(w => console.log(`  ${w.ref}  ${w.title}`));
  }
}

if (require.main === module) main();

module.exports = { main, USAGE };
