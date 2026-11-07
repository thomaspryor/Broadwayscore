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

// Returns { leases, unreadable }. `unreadable: true` means "could not prove
// this worktree is NOT protected by a live lease" and callers must fail
// SAFE (treat as live) — matching gc-worktree-liveness.js's own any-lsof-
// error-means-live contract, which the original cut of this function
// diverged from (adversarial review finding: an unreadable/corrupt lease
// silently read as "no live lease", the opposite direction of every other
// liveness guard in this file's neighborhood).
//
// Two error shapes are deliberately NOT `unreadable`, because they are the
// EXPECTED shape of a lease that just finished: releaseLease() does a
// recursive rmSync of the whole per-task lease dir on completion, so a dir
// listed by readdirSync() above and then gone (or its lease.json gone) by
// the time we read it is a benign race, not a signal of anything live.
//  - the per-task lease DIRECTORY disappearing between list and read
//  - lease.json specifically missing (ENOENT) inside a dir that still exists
// Anything else — a read error for another reason, or JSON.parse failing on
// content that WAS read (a torn read of an in-progress non-atomic write,
// i.e. exactly the moment a lease is being actively written) — is the
// poison case: unreadable = true.
function readLeases(leaseRoot) {
  let dirs;
  try {
    dirs = fs.readdirSync(leaseRoot);
  } catch (e) {
    // Genuinely no leases have ever been written — fine, not unreadable.
    return { leases: [], unreadable: e.code !== 'ENOENT' };
  }
  const leases = [];
  let unreadable = false;
  for (const d of dirs) {
    const leaseFile = path.join(leaseRoot, d, 'lease.json');
    let raw;
    try {
      raw = fs.readFileSync(leaseFile, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') unreadable = true;
      continue;
    }
    try {
      leases.push(JSON.parse(raw));
    } catch {
      unreadable = true; // torn read of an in-flight write — fail safe
    }
  }
  return { leases, unreadable };
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function hasLiveLease(worktreePath, { leaseRoot = LEASE_ROOT, isAliveFn = pidLooksLikeClaude } = {}) {
  const { leases, unreadable } = readLeases(leaseRoot);
  if (unreadable) return true; // can't disprove liveness — fail safe
  const target = realpathOrSelf(worktreePath);
  const liveCwds = computeLiveLeaseCwds(leases, isAliveFn);
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
