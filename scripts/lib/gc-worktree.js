'use strict';
/**
 * Worktree triage (BRO-2205): turns `git worktree list --porcelain` output
 * plus the gathered removal signals into one per-worktree report row —
 * "Triage script reporting per worktree: age, size, branch, uncommitted
 * count, commits off origin/main, lock status" from the original card.
 *
 * The actual merge/lease removability call is NOT reimplemented here — it
 * already exists, is tested, and is exercised in production by
 * gc-merged-worktrees.sh: see decideWorktreeReclaim() in
 * ./worktree-gc-reclaim.js (CLAUDE.md rule 15). This module adds the one
 * piece that logic does not know about: `git worktree lock` (git's own
 * native lock, distinct from the GC script's serialization lock). A worktree
 * can be clean AND fully merged AND still be a pinned, active session —
 * exactly the "diary calendar Phase 0 picker work" case the original card's
 * audit found. A lock always wins, before the merge/lease verdict is even
 * consulted.
 *
 * No I/O here — callers parse `git worktree list --porcelain` with
 * parseWorktreeListPorcelain() and gather age/size/uncommitted-count/merge
 * signals themselves (git, fs.stat, `du`), then call triageWorktree() per
 * record. That keeps this file requireable in a plain node:test file with
 * zero fixtures, same pattern as worktree-gc-reclaim.js.
 */
const { decideWorktreeReclaim } = require('./worktree-gc-reclaim.js');

/**
 * Parse `git worktree list --porcelain` output into one record per
 * worktree. Mirrors the field-by-field parse gc-merged-worktrees.sh already
 * does in bash (see its "Parse `git worktree list --porcelain`" section) —
 * kept here as a JS-callable equivalent so a triage report can be built
 * without shelling out to the bash script's internals.
 *
 * `isPrimary` is set on the FIRST record only: `git worktree list` always
 * lists the main/primary working tree first (the one `git worktree add`
 * branches off of, not itself removable by any of this repo's GC tooling —
 * see gc-merged-worktrees.sh's own `[ "$path" = "$REPO" ]` special case).
 * Deriving it from position rather than a caller-supplied path means this
 * function works without the caller knowing the repo root, and without
 * hardcoding a default-branch name (adversarial review finding: an earlier
 * version had no primary-checkout exclusion at all, so a generic caller
 * that fed every parsed record into triageWorktree() with normal signals
 * would see the primary checkout itself come back removable — main is
 * trivially "already an ancestor of origin/main").
 *
 * @param {string} output - raw stdout of `git worktree list --porcelain`
 * @returns {Array<{path: string, branch: string|null, locked: boolean,
 *   lockedReason: string, bare: boolean, detached: boolean, isPrimary: boolean}>}
 */
function parseWorktreeListPorcelain(output) {
  const worktrees = [];
  let current = null;
  const flush = () => {
    if (current) worktrees.push(current);
    current = null;
  };
  for (const line of (output || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        locked: false,
        lockedReason: '',
        bare: false,
        detached: false,
        isPrimary: worktrees.length === 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
      current.lockedReason = line === 'locked' ? '' : line.slice('locked '.length);
    }
  }
  flush();
  return worktrees;
}

/**
 * Decide removability for one worktree and shape it into a report row.
 *
 * @param {{path: string, branch: string|null, locked: boolean, lockedReason: string}} record
 *   one entry from parseWorktreeListPorcelain()
 * @param {object} signals
 * @param {boolean} signals.isAncestorOfMain
 * @param {boolean} signals.hasUnmergedCommits
 * @param {boolean} signals.hasLiveLease
 * @param {number} [signals.ageDays] - report-only, not part of the decision
 *   (decideWorktreeReclaim deliberately does not age-gate: a provably merged,
 *   lease-free worktree is safe to reclaim immediately, and an unmerged one
 *   is never safe regardless of age)
 * @param {number} [signals.sizeBytes] - report-only
 * @param {number} [signals.uncommittedCount] - report-only
 * @returns {{path: string, branch: string|null, removable: boolean,
 *   reason: string, ageDays?: number, sizeBytes?: number, uncommittedCount?: number}}
 */
function triageWorktree(record, signals = {}) {
  const { isAncestorOfMain, hasUnmergedCommits, hasLiveLease, ageDays, sizeBytes, uncommittedCount } = signals;
  const base = { path: record.path, branch: record.branch, ageDays, sizeBytes, uncommittedCount };

  if (record.bare) {
    // A bare worktree entry is the repo's own administrative record, never a
    // real checkout to reclaim (adversarial review finding: bare/detached
    // flags survive parseWorktreeListPorcelain() but were silently dropped
    // here, so a caller iterating every parsed record with real-looking
    // merge signals could see this reported removable).
    return { ...base, removable: false, reason: 'bare worktree entry — not a reclaimable checkout' };
  }

  if (record.isPrimary) {
    // The main/primary checkout (see parseWorktreeListPorcelain's docstring)
    // is never a GC candidate — mirrors gc-merged-worktrees.sh's own
    // `[ "$path" = "$REPO" ]` special case (adversarial review finding).
    return { ...base, removable: false, reason: 'primary checkout — not a reclaimable worktree' };
  }

  if (record.detached) {
    // No branch to evaluate merge-ancestry against; gc-merged-worktrees.sh
    // unconditionally SKIPs detached-HEAD worktrees rather than guessing
    // (adversarial review finding: detached survives parsing but was never
    // checked here).
    return { ...base, removable: false, reason: 'detached HEAD — no branch to evaluate against origin/main' };
  }

  if (record.locked) {
    return {
      ...base,
      removable: false,
      reason: `git-locked${record.lockedReason ? `: ${record.lockedReason}` : ''}`,
    };
  }

  // Fail safe on incomplete signals (adversarial review finding): a caller
  // that forgot to gather one of the three booleans — e.g. the lease scan
  // errored, or a field was typo'd — must never see that silently read as
  // "false" and fall through to decideWorktreeReclaim's default-removable
  // branches. Only a fully-specified, all-boolean signal set is trusted.
  const hasCompleteSignals = [isAncestorOfMain, hasUnmergedCommits, hasLiveLease].every((v) => typeof v === 'boolean');
  if (!hasCompleteSignals) {
    return { ...base, removable: false, reason: 'incomplete merge/lease signals — refusing to authorize removal' };
  }

  const decision = decideWorktreeReclaim({ isAncestorOfMain, hasUnmergedCommits, hasLiveLease });
  return { ...base, removable: decision.removable, reason: decision.reason };
}

module.exports = { parseWorktreeListPorcelain, triageWorktree };
