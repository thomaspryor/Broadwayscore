#!/usr/bin/env node
'use strict';
/**
 * CLI wrapper around decideWorktreeReclaim() (BRO-2319) — the single point
 * where gc-merged-worktrees.sh's three independently-gathered signals
 * (git-cherry/merge-base ancestor check, unmerged-commit count, live-lease
 * scan) actually get turned into one removal decision. Without this, the
 * bash script's own inline `if` chain IS the decision and
 * worktree-gc-reclaim.js is only exercised by its unit test — a change to
 * one and not the other silently diverges. Bash still owns gathering the
 * raw signals (that's genuinely its job: git plumbing, lease-file scans);
 * this CLI owns turning them into a verdict.
 *
 * Usage: worktree-gc-decide.js --is-ancestor=0|1 --has-unmerged=0|1 --has-live-lease=0|1
 * Exit codes: 0 = removable, 1 = not removable. Prints {removable, reason} JSON.
 */
const { decideWorktreeReclaim } = require('./worktree-gc-reclaim.js');

function boolFlag(name, argv) {
  const pref = `--${name}=`;
  const a = argv.find((x) => x.startsWith(pref));
  return a ? (a.slice(pref.length) === '1' || a.slice(pref.length) === 'true') : false;
}

function main() {
  const argv = process.argv.slice(2);
  const result = decideWorktreeReclaim({
    isAncestorOfMain: boolFlag('is-ancestor', argv),
    hasUnmergedCommits: boolFlag('has-unmerged', argv),
    hasLiveLease: boolFlag('has-live-lease', argv),
  });
  console.log(JSON.stringify(result));
  process.exit(result.removable ? 0 : 1);
}

if (require.main === module) main();

module.exports = { main };
