/**
 * duplicate-dispatch-guard — pure predicate for the two collision paths that
 * produced real damage on 2026-07-26/27 (task #542, card 3a9637c5):
 *
 *   1. A second EnterWorktree call landing on a same-name worktree that a
 *      LIVE session already owns ("resumed as-is"), so two agents wrote the
 *      same four files concurrently.
 *
 * (The second collision path, double-fixing one CI red, had a claim-ledger
 * check here; it never ran and was removed in BRO-5931.)
 * The check takes plain data in and returns a plain verdict out — no fs/git/
 * task-list I/O here, so the decision is unit-testable without a real repo
 * or a live task list. Real callers gather the actual state and hand it to
 * this function:
 *   - evaluateWorktreeEntry is wired: scripts/check-worktree-collision.js
 *     (real git state) + .claude/hooks/enterworktree-guard.sh (PreToolUse on
 *     EnterWorktree) call it automatically before every worktree entry.
 */

'use strict';

// worktreeState: { name, exists, locked, lockReason, dirty } | null/undefined
// `exists: false` (or a falsy worktreeState) means no prior worktree of this
// name — always safe, there is nothing to collide with.
function evaluateWorktreeEntry(worktreeState) {
  if (!worktreeState || !worktreeState.exists) {
    return { allow: true, reason: 'no existing worktree with this name' };
  }

  // Locked is the strongest signal: cmux/Claude Code locks a worktree only
  // while a session owns it (see EnterWorktree's own lock reason strings,
  // e.g. "claude session <name> (pid ... start ...)"). Checked before dirty
  // because a live session's worktree is often ALSO dirty (mid-edit) — the
  // lock is the more specific, more confident reason to refuse.
  if (worktreeState.locked) {
    return {
      allow: false,
      reason: `worktree "${worktreeState.name}" is locked (${worktreeState.lockReason || 'no reason given'}) — treat as a live owner, refuse the resume`,
    };
  }

  if (worktreeState.dirty) {
    return {
      allow: false,
      reason: `worktree "${worktreeState.name}" has uncommitted changes — resuming would risk clobbering another session's WIP`,
    };
  }

  return { allow: true, reason: 'existing worktree is clean and unlocked — safe to resume' };
}

// Entry point: refuse the second entrant onto a live same-name worktree.
function checkDuplicateDispatch({ worktreeState = null } = {}) {
  if (worktreeState) {
    const verdict = evaluateWorktreeEntry(worktreeState);
    if (!verdict.allow) return verdict;
  }
  return { allow: true, reason: 'no collision detected' };
}

module.exports = {
  evaluateWorktreeEntry,
  checkDuplicateDispatch,
};
