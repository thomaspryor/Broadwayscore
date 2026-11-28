'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasLiveProcessInDir } = require('./gc-worktree-liveness.js');
const { hasLiveLease } = require('./worktree-live-lease-check.js');
const { holdsIgnoredWork } = require('./codex-runner.js');

const OWNER_FILE = '.acceptance-owner.json';

function processStart(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function writeOwner(dir) {
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({
    pid: process.pid, started: processStart(process.pid),
  }), { flag: 'wx', mode: 0o600 });
}

// Missing metadata is a legacy checkout. Unreadable metadata keeps the tree.
function ownerState(dir) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? 'legacy' : 'unknown'; }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.started) return 'unknown';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
  // A changed identity may be PID reuse or a different ps locale/timezone.
  // Keep it while that PID exists; only ESRCH proves the owner is gone.
  try { return processStart(owner.pid) === owner.started ? 'live' : 'unknown'; }
  catch { return 'unknown'; }
}

function checkoutInUse(wt) {
  if (hasLiveProcessInDir(wt) || hasLiveLease(wt)) return true;
  try {
    const commands = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
    return commands.split('\n').some((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match && Number(match[1]) !== process.pid && match[2].includes(path.dirname(wt));
    });
  } catch { return true; }
}

/** The worktree's gitdir from its .git file (git >= 2.48 may write it relative). null if unreadable. */
function worktreeGitdir(wt) {
  try {
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    return m ? path.resolve(wt, m[1]) : null;
  } catch { return null; }
}

/**
 * `git worktree lock` state: 'none', 'initializing' (a `git worktree add` that
 * was killed mid-populate leaves this reason behind; temp-worktree.js), or
 * 'locked' (a deliberate lock, or unreadable: never removed).
 */
function worktreeLock(wt) {
  const gitdir = worktreeGitdir(wt);
  if (gitdir === null) return 'locked';
  let reason;
  try { reason = fs.readFileSync(path.join(gitdir, 'locked'), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? 'none' : 'locked'; }
  return /^initializing\b/.test(reason.trim()) ? 'initializing' : 'locked';
}

/**
 * BRO-8124: the ONE removal policy for makeFreshCheckout's throwaway
 * <tmp>/<prefix>XXXXXX/main checkouts, shared by the owner's own cleanup
 * (acceptance-check-core.js removeCheckout) and the reaper
 * (reap-temp-checkouts.js). Ownership (live/dead) is the caller's job.
 *
 * Check-run dirt (isCheckRunDirt) does NOT block removal. These trees are made by a script, at an
 * origin/main sha, to run checks; the dirt in them is what those checks wrote
 * (2026-11-23: a fixture row appended to the tracked stage-latency.jsonl, a
 * test temp dir, or 747 deletions from a checkout killed mid-populate), and
 * the old "dirty means keep" rule (05e30fdacd0) stranded 10.9GB of baselines
 * whose owners were long dead. Other changes (someone edited source in it)
 * keep it unless the caller passes allowUnexpectedDirt (the reaper does after
 * 24h idle).
 *
 * Still kept: .env / review-texts git work, a live process or lease, a
 * deliberate git lock, commits not on origin/main (or HEAD moved off the
 * pinned sha). Callers re-check open files (lsof) right before deleting.
 * @returns {{ok:boolean, reason:string, kind?:'registered'|'standalone', dirt?:number, force?:number}}
 */
/**
 * Dirt a check run leaves behind, safe to discard: deletions (the content is
 * at HEAD, on origin/main), data/audit/ ledger churn (gc-merged-worktrees.sh
 * is_safe_dirty allows the same), python caches, and untracked test temp dirs
 * at the root (.bro-3151-test-XXXXXX/). Anything else is "unexpected".
 */
function isCheckRunDirt(line) {
  const xy = line.slice(0, 2);
  const f = line.slice(3);
  if (f.includes(' -> ') || f.startsWith('"')) return false;
  if (xy === ' D' || xy === 'D ') return true;
  if (f.startsWith('data/audit/')) return true;
  if (/\.pyc$|(^|\/)__pycache__\//.test(f)) return true;
  if (xy === '??' && /^\.[^/]*test[^/]*\//i.test(f)) return true;
  return false;
}

const strictMode = () => process.env.TEMP_CHECKOUT_REAP_DISABLED === '1';

function removableTempCheckout(wt, { sha = null, standalone = null, allowUnexpectedDirt = false } = {}) {
  if (holdsIgnoredWork(wt)) return { ok: false, reason: 'holds .env or review-texts git work' };
  if (checkoutInUse(wt)) return { ok: false, reason: 'a live process or lease is in it' };
  let gitSt;
  try { gitSt = fs.lstatSync(path.join(wt, '.git')); } catch { return { ok: false, reason: 'no .git' }; }
  const kind = standalone === null ? (gitSt.isDirectory() ? 'standalone' : 'registered') : (standalone ? 'standalone' : 'registered');
  const git = (args) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let force = 1;
  if (kind === 'registered') {
    const lock = worktreeLock(wt);
    if (lock === 'locked') return { ok: false, kind, reason: 'git worktree is locked' };
    if (lock === 'initializing') force = 2;
  }
  let dirt;
  try {
    const head = git(['rev-parse', 'HEAD']);
    if (sha && head !== sha) return { ok: false, kind, reason: 'HEAD moved off the pinned sha' };
    if (kind === 'standalone') {
      if (git(['rev-list', '--count', 'origin/main..HEAD']) !== '0') return { ok: false, kind, reason: 'commits not on origin/main' };
    } else if (!sha) {
      try { execFileSync('git', ['-C', wt, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { timeout: 30000, stdio: 'ignore' }); }
      catch { return { ok: false, kind, reason: 'HEAD not on origin/main' }; }
    }
    const lines = execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
    dirt = lines.length;
    // Kill switch: TEMP_CHECKOUT_REAP_DISABLED=1 restores "any dirt keeps it".
    if (dirt && strictMode()) return { ok: false, kind, dirt, reason: 'dirty (TEMP_CHECKOUT_REAP_DISABLED=1)' };
    const unexpected = lines.filter((l) => !isCheckRunDirt(l));
    if (unexpected.length && !allowUnexpectedDirt) return { ok: false, kind, dirt, unexpectedDirt: unexpected.length, reason: `${unexpected.length} changed path(s) a check run does not leave (first: ${unexpected[0].slice(3)})` };
  } catch (error) {
    return { ok: false, kind, reason: `git unreadable: ${String(error.message || error).split('\n')[0]}` };
  }
  return { ok: true, kind, dirt, force, reason: dirt ? `discarding ${dirt} dirty path(s)` : 'clean' };
}

/** Owner gone (dead/legacy) and the tree passes the full removableTempCheckout rule. */
function canReapCheckout(wt) {
  const owner = ownerState(path.dirname(wt));
  if (owner === 'live' || owner === 'unknown') return false;
  return removableTempCheckout(wt).ok;
}

if (require.main === module) {
  const [operation, wt] = process.argv.slice(2);
  if (!wt || !['owner', 'safe'].includes(operation)) process.exit(2);
  if (operation === 'owner') console.log(ownerState(path.dirname(wt)));
  else process.exit(canReapCheckout(wt) ? 0 : 1);
}

module.exports = { writeOwner, ownerState, checkoutInUse, canReapCheckout, removableTempCheckout, isCheckRunDirt, worktreeLock, worktreeGitdir, OWNER_FILE };
