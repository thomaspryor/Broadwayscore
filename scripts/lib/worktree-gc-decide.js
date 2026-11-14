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
 *          [--cwd-pin=<class>] [--worktree-idle=0|1]
 * --cwd-pin is a classifyCwdPin() class from `gc-worktree-liveness.js
 * --classify` (BRO-2694); absent = 'none', unrecognised = 'unknown' (keep).
 * Exit codes: 0 = removable, 3 = blocked only by a cwd pin, 1 = any other
 * not-removable. Prints {removable, blocker, reason} JSON.
 */
const { decideWorktreeReclaim, CWD_PIN_CLASSES } = require('./worktree-gc-reclaim.js');

function boolFlag(name, argv) {
  const pref = `--${name}=`;
  const a = argv.find((x) => x.startsWith(pref));
  return a ? (a.slice(pref.length) === '1' || a.slice(pref.length) === 'true') : false;
}

function stringFlag(name, argv) {
  const pref = `--${name}=`;
  const a = argv.find((x) => x.startsWith(pref));
  return a === undefined ? undefined : a.slice(pref.length);
}

/** argv -> {result, exitCode}; exported so the test drives the real parsing. */
function decideFromArgv(argv) {
  const pinArg = stringFlag('cwd-pin', argv);
  const cwdPin = pinArg === undefined ? 'none' : (CWD_PIN_CLASSES.includes(pinArg) ? pinArg : 'unknown');
  const result = decideWorktreeReclaim({
    isAncestorOfMain: boolFlag('is-ancestor', argv),
    hasUnmergedCommits: boolFlag('has-unmerged', argv),
    hasLiveLease: boolFlag('has-live-lease', argv),
    cwdPin,
    worktreeIdle: boolFlag('worktree-idle', argv),
  });
  const exitCode = result.removable ? 0 : (result.blocker === 'cwd-pin' ? 3 : 1);
  return { result, exitCode };
}

function main() {
  const { result, exitCode } = decideFromArgv(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { main, decideFromArgv };
