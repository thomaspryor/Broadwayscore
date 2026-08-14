/**
 * worktree-branch-guard.js — real I/O half of the card #1281 cross-session
 * duplicate-dispatch fix. The pure predicates (matchesTaskWorkBranch,
 * findWorkBranchCollisions, workBranchCollisionGuard) live in
 * dispatch-guards.js alongside the other six dispatch guards, per that
 * file's own header rationale ("so a second dispatcher never re-derives —
 * and inevitably drifts from — these refusals"). NOTE: as of this writing
 * linear-next.js does NOT yet call workBranchCollisionGuard — its headless
 * job/linear-BRO-* branches are still unguarded by this check. Living in
 * dispatch-guards.js only means linear-next.js CAN adopt it with one
 * require() line; it does not mean it already has (ship-check adversarial
 * review, 2026-08-14 — an earlier draft of this comment overclaimed that).
 * This file only shells out to git to build the {name, unlandedCommits}
 * list those pure functions consume.
 *
 * Correctness notes (second-opinion + ship-check adversarial review, 2026-08-14):
 *   - Filters branch names to task-matching candidates BEFORE any per-branch
 *     git call. A live checkout can carry 500+ matching "worktree-" and
 *     "job/" prefixed branches at once (measured 2026-08-14: 539 + 41) —
 *     is-ancestor and cherry are real subprocess spawns, unaffordable run
 *     unconditionally against every branch on every dispatch.
 *   - Reuses scripts/gc-merged-worktrees.sh's exact landed-check sequence
 *     (fetch origin/<default> first, `merge-base --is-ancestor` fast path,
 *     fall back to `git cherry` so a squash-merged branch — work that
 *     already landed — is never reported as an unlanded collision).
 *   - Per-branch try/catch, not one loop-wide catch: one bad ref/timeout
 *     disables the check for that branch only, not for every candidate.
 */

'use strict';

const { execFileSync } = require('child_process');
const { matchesTaskWorkBranch } = require('./dispatch-guards.js');

function unlandedCommitsFor(branch, repoDir, defaultBranch) {
  const upstream = `origin/${defaultBranch}`;
  let headSha = null;
  try {
    headSha = execFileSync('git', ['rev-parse', '--verify', '--quiet', branch], { cwd: repoDir, encoding: 'utf8' }).trim();
  } catch {
    // Branch vanished between listing and check (raced a delete) — no
    // signal, fall through to the cherry check below (will also no-op).
  }
  if (headSha) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', headSha, upstream], { cwd: repoDir, timeout: 15000 });
      return []; // fully contained in origin/<defaultBranch> — landed (fast path)
    } catch {
      // Not a plain ancestor — could still be squash-merged; fall through.
    }
  }
  // '+' = git found no patch-id-equivalent commit upstream (truly unlanded);
  // '-' = an equivalent commit already landed (the squash-merge case this
  // exists to catch). Deliberately DIVERGES from scripts/gc-merged-
  // worktrees.sh's own "timeout = unmerged" default (ship-check adversarial
  // review, 2026-08-14): that script's failure mode is KEEP-the-worktree
  // (harmless, mildly wasteful); this guard's failure mode is REFUSE-the-
  // dispatch, which under repo-wide git contention (a stuck lock, disk
  // pressure) would fail CLOSED for every task hitting this guard at once —
  // the opposite of every sibling guard's fail-open convention (see this
  // file's own header and dispatch-guards.js's repeated "a missing signal
  // must never block a dispatch" rule). A cherry failure/timeout is
  // therefore treated as NO signal, same as a listing failure below.
  let raw;
  try {
    raw = execFileSync('git', ['cherry', '-v', upstream, branch], { cwd: repoDir, encoding: 'utf8', timeout: 15000 });
  } catch {
    return [];
  }
  return raw.split('\n').filter(l => l.startsWith('+')).map(l => l.replace(/^\+\s*/, ''));
}

// taskId is required and used to pre-filter BEFORE any per-branch git call —
// see the file header for why this is not optional.
function listWorkBranchStatuses(taskId, { repoDir, defaultBranch = 'main' } = {}) {
  try {
    // Best-effort refresh of the local origin/<defaultBranch> tracking ref
    // (gc-merged-worktrees.sh fetches for the identical reason: a stale
    // local ref makes an already-landed branch look unlanded). Non-fatal —
    // offline/timeout falls back to whatever origin/<defaultBranch> already
    // points at locally.
    execFileSync('git', ['fetch', 'origin', defaultBranch, '-q'], { cwd: repoDir, timeout: 20000 });
  } catch {
    // offline/timeout — use cached origin ref
  }

  let names;
  try {
    const raw = execFileSync('git', ['branch', '--list', 'worktree-*', 'job/*', '--format=%(refname:short)'], { cwd: repoDir, encoding: 'utf8' });
    names = raw.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }

  const candidates = names.filter(name => matchesTaskWorkBranch(name, taskId));

  return candidates.map(name => {
    try {
      return { name, unlandedCommits: unlandedCommitsFor(name, repoDir, defaultBranch) };
    } catch {
      return { name, unlandedCommits: [] };
    }
  });
}

module.exports = { listWorkBranchStatuses, unlandedCommitsFor };
