/**
 * worktree-branch-guard.js — real I/O half of the card #1281 cross-session
 * duplicate-dispatch fix. The pure predicates (matchesTaskWorkBranch,
 * findWorkBranchCollisions, workBranchCollisionGuard) live in
 * dispatch-guards.js alongside the other six dispatch guards, per that
 * file's own header rationale ("so a second dispatcher never re-derives —
 * and inevitably drifts from — these refusals").
 *
 * BRO-278 (2026-08-26): linear-next.js now calls workBranchCollisionGuard
 * too (docs/dispatcher-safety-port-table.md row A5, PORT — done). Porting it
 * alone wasn't enough — matchesTaskWorkBranch matched the RAW ledger taskId
 * (`linear:BRO-278`) against branch names, but bsc-runner.js's gitSafeJobId()
 * sanitizes that git-illegal colon to a dash before the branch is ever
 * created (`job/linear-BRO-278-<suffix>`), so the match could never fire for
 * a Linear dispatch even once wired in. Fixed by sanitizing with the same
 * gitSafeJobId inside matchesTaskWorkBranch — see that function's own
 * comment in dispatch-guards.js. This was the root cause of the 2026-08-12
 * incident (three cmux workspaces independently working the identical
 * Linear issue, undetected).
 *
 * This file shells out to git to build the {name, status, reason,
 * unlandedCommits} list and reports the relationship during dispatch.
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

/**
 * BRO-2814: an empty upstream..branch range is not evidence of lost work.
 * Report the relationship explicitly instead of making readers interpret [].
 * "genuinely-empty" means the refs have the same tip, not that a worker
 * produced nothing: a just-landed job can also point at main's current tip.
 * Determining whether a job produced commits requires its starting SHA.
 */
function classifyJobBranch(branch, repoDir, defaultBranch = 'main') {
  const upstream = `origin/${defaultBranch}`;
  const git = (args) => execFileSync('git', args, {
    cwd: repoDir, encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const result = (status, reason, unlandedCommits = []) => ({ status, reason, unlandedCommits });
  let headSha;
  let upstreamSha;
  try {
    headSha = git(['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`]);
    upstreamSha = git(['rev-parse', '--verify', '--end-of-options', `${upstream}^{commit}`]);
  } catch {
    return result('unknown', 'branch or upstream could not be resolved');
  }
  if (headSha === upstreamSha) {
    return result('genuinely-empty', 'same tip as upstream; may have just landed; worker output cannot be inferred');
  }
  try {
    git(['merge-base', '--is-ancestor', headSha, upstreamSha]);
    return result('landed', 'branch head is an ancestor of upstream');
  } catch (err) {
    if (err.status !== 1) return result('unknown', 'ancestry check failed');
  }
  try {
    if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
      return result('unknown', 'shallow history cannot rule out a landing');
    }
  } catch {
    return result('unknown', 'history completeness could not be checked');
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
    raw = git(['cherry', '-v', upstreamSha, headSha]);
  } catch {
    return result('unknown', 'patch comparison failed');
  }
  const unlandedCommits = raw.split('\n').filter(l => l.startsWith('+')).map(l => l.replace(/^\+\s*/, ''));
  if (unlandedCommits.length) {
    return result('unlanded-with-commits', 'commits have no patch equivalent upstream', unlandedCommits);
  }
  if (/^-/m.test(raw)) {
    // cherry omits merges even when it lists equivalent ordinary commits.
    // A branch-exclusive merge may contain resolutions absent upstream.
    try {
      if (git(['rev-list', '--merges', '--max-count=1', `${upstreamSha}..${headSha}`])) {
        return result('unknown', 'patch comparison omits branch-exclusive merge resolutions');
      }
    } catch {
      return result('unknown', 'merge history could not be checked');
    }
    return result('landed', 'patch-equivalent commits are already upstream');
  }
  // git cherry omits merges. Empty output cannot prove equivalence.
  return result('unknown', 'patch comparison produced no evidence');
}

function unlandedCommitsFor(branch, repoDir, defaultBranch) {
  return classifyJobBranch(branch, repoDir, defaultBranch).unlandedCommits;
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
    // unbounded-fetch-ok: this only ever runs from a live bsc-next.js dispatch
    // (a full local/cmux checkout), never from a CI workflow — audit-unbounded-
    // fetch.js's static reachability trace flags it anyway because
    // dispatch-guards.js (which this file's matchesTaskWorkBranch feeds) is
    // required by bsc-next.test.mjs, which some shallow-checkout workflow runs;
    // the git-fetch code path here is never actually invoked during tests.
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
      const classification = classifyJobBranch(name, repoDir, defaultBranch);
      console.error(`[work-branch] ${name}: ${classification.status} (${classification.reason})`);
      return { name, ...classification };
    } catch {
      return { name, status: 'unknown', reason: 'branch check failed', unlandedCommits: [] };
    }
  });
}

module.exports = { classifyJobBranch, listWorkBranchStatuses, unlandedCommitsFor };
