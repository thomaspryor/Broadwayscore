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
 * @param {string} output - raw stdout of `git worktree list --porcelain`
 * @returns {Array<{path: string, branch: string|null, locked: boolean,
 *   lockedReason: string, bare: boolean, detached: boolean}>}
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

  if (record.locked) {
    return {
      ...base,
      removable: false,
      reason: `git-locked${record.lockedReason ? `: ${record.lockedReason}` : ''}`,
    };
  }

  const decision = decideWorktreeReclaim({ isAncestorOfMain, hasUnmergedCommits, hasLiveLease });
  return { ...base, removable: decision.removable, reason: decision.reason };
}

module.exports = { parseWorktreeListPorcelain, triageWorktree };
