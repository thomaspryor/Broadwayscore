/**
 * duplicate-dispatch-guard — pure predicate for the two collision paths that
 * produced real damage on 2026-07-26/27 (task #542, card 3a9637c5):
 *
 *   1. A second EnterWorktree call landing on a same-name worktree that a
 *      LIVE session already owns ("resumed as-is"), so two agents wrote the
 *      same four files concurrently.
 *   2. Two sessions independently diagnosing and fixing the same CI red
 *      (the shouldShowSentiment ReferenceError), producing a double-declared
 *      symbol — the fix collision itself broke main a second way.
 *
 * Both checks take plain data in and return a plain verdict out — no fs/git/
 * task-list I/O here, so the decision is unit-testable without a real repo
 * or a live task list. Real callers gather the actual state and hand it to
 * these functions:
 *   - evaluateWorktreeEntry is wired: scripts/check-worktree-collision.js
 *     (real git state) + .claude/hooks/enterworktree-guard.sh (PreToolUse on
 *     EnterWorktree) call it automatically before every worktree entry.
 *   - evaluateCiRedClaim has NO automatic caller. A PreToolUse hook is a
 *     separate bash process and cannot call the TaskList/TaskGet tools the
 *     shared task list lives behind — there is no file-based task-list
 *     source a hook can read. Consulting it before pushing a CI-red fix is
 *     currently a manual step: call TaskList yourself, pass the results here.
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

// ciRedTarget: { symbol, runId } — at least one should be set. Matches
// case-insensitively against each candidate task's subject+description, the
// same substring approach #563's own duplicate (task #563 vs the
// concurrently-fixing session) would have caught: the fixing task's title
// literally named the symbol.
function taskClaimsTarget(task, ciRedTarget) {
  const haystack = `${task.subject || ''} ${task.description || ''}`.toLowerCase();
  if (ciRedTarget.symbol && haystack.includes(String(ciRedTarget.symbol).toLowerCase())) return true;
  if (ciRedTarget.runId && haystack.includes(String(ciRedTarget.runId).toLowerCase())) return true;
  return false;
}

// existingClaims: array of task-like objects { id, status, subject, description }
// (the shape returned by this harness's shared task list). Refuses only when
// another IN_PROGRESS task already names this CI red — a completed or
// pending task isn't an active claim.
function evaluateCiRedClaim(ciRedTarget, existingClaims) {
  if (!ciRedTarget || (!ciRedTarget.symbol && !ciRedTarget.runId)) {
    return { allow: true, reason: 'no CI-red target given' };
  }
  const claim = (existingClaims || []).find(
    t => t.status === 'in_progress' && taskClaimsTarget(t, ciRedTarget)
  );
  if (claim) {
    return {
      allow: false,
      reason: `CI red for "${ciRedTarget.symbol || ciRedTarget.runId}" is already claimed by in_progress task #${claim.id} ("${claim.subject}")`,
      claimedBy: claim,
    };
  }
  return { allow: true, reason: 'no in_progress task already claims this CI red' };
}

// Composed entry point: given (worktree state, existing claims), refuse the
// second entrant if EITHER sub-check refuses. Callers only pass the piece
// they're checking (worktreeState for an EnterWorktree call, ciRedTarget +
// existingClaims for a pre-push CI-red fix) — both together also works.
function checkDuplicateDispatch({ worktreeState = null, ciRedTarget = null, existingClaims = [] } = {}) {
  if (worktreeState) {
    const verdict = evaluateWorktreeEntry(worktreeState);
    if (!verdict.allow) return verdict;
  }
  if (ciRedTarget) {
    const verdict = evaluateCiRedClaim(ciRedTarget, existingClaims);
    if (!verdict.allow) return verdict;
  }
  return { allow: true, reason: 'no collision detected' };
}

module.exports = {
  evaluateWorktreeEntry,
  evaluateCiRedClaim,
  taskClaimsTarget,
  checkDuplicateDispatch,
};
