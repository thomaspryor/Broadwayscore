#!/usr/bin/env node
'use strict';
/**
 * CLI liveness check for gc-merged-worktrees.sh (BRO-2319): "does a live
 * job-lease have this worktree as its cwd?" — checked BEFORE any removal
 * decision, same exit-code contract as gc-worktree-liveness.js (0 = live,
 * do not remove; 1 = clear). Kept separate from the lsof-based cwd check:
 * that one answers "is any live process using this dir", this one answers
 * the narrower, cheaper, more authoritative question for auto-dispatched
 * job-* worktrees specifically — a lease file with a live pid is a direct
 * signal from the dispatcher, not an inference from process tables.
 *
 * Decision logic lives in worktree-gc-reclaim.js (computeLiveLeaseCwds) —
 * this file is only I/O: read every lease, resolve the path, ask.
 */
const fs = require('fs');
const path = require('path');
const { pidLooksLikeClaude, LEASE_ROOT } = require('./bsc-runner.js');
const { computeLiveLeaseCwds } = require('./worktree-gc-reclaim.js');

function readLeases(leaseRoot) {
  let dirs = [];
  try { dirs = fs.readdirSync(leaseRoot); } catch { return []; }
  const leases = [];
  for (const d of dirs) {
    try {
      leases.push(JSON.parse(fs.readFileSync(path.join(leaseRoot, d, 'lease.json'), 'utf8')));
    } catch { /* missing/corrupt lease — ignore, fails safe (not live) */ }
  }
  return leases;
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function hasLiveLease(worktreePath, { leaseRoot = LEASE_ROOT, isAliveFn = pidLooksLikeClaude } = {}) {
  const target = realpathOrSelf(worktreePath);
  const liveCwds = computeLiveLeaseCwds(readLeases(leaseRoot), isAliveFn);
  for (const cwd of liveCwds) {
    if (realpathOrSelf(cwd) === target) return true;
  }
  return false;
}

function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--path='));
  const worktreePath = arg ? arg.slice('--path='.length) : process.argv[2];
  if (!worktreePath) {
    console.error('usage: worktree-live-lease-check.js --path=<worktree-dir>');
    process.exit(2);
  }
  const live = hasLiveLease(worktreePath);
  console.log(JSON.stringify({ path: worktreePath, live }));
  // Exit codes: 0 = live lease found (do NOT remove), 1 = clear (safe to remove).
  process.exit(live ? 0 : 1);
}

if (require.main === module) main();

module.exports = { hasLiveLease, readLeases };
