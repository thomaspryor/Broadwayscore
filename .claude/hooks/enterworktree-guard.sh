#!/usr/bin/env bash
# PreToolUse hook on EnterWorktree — refuses a same-name resume when the
# existing worktree is locked or dirty (task #542, card 3a9637c5).
#
# Incident (2026-07-26/27): EnterWorktree(name: X) reported "A worktree with
# this name already existed and was resumed as-is" when a parallel session
# already owned that worktree and had it locked mid-edit. Two agents then
# wrote the same four files concurrently. EnterWorktree itself has no
# refuse-on-collision behavior; this hook adds one in front of it using
# scripts/check-worktree-collision.js (real git state) +
# scripts/lib/duplicate-dispatch-guard.js (the pure decision, unit-tested in
# tests/unit/duplicate-dispatch-guard.test.mjs).
#
# Only fires when `name` is given (a fresh-or-resumed worktree by name) — a
# `path` entry into a worktree the session already knows about is unaffected.
# This is deliberate, not a gap: EnterWorktree's own docs say a KNOWN existing
# worktree should be re-entered via `path`, not `name` — the incident this
# hook exists to prevent happened because a session used `name` for what
# should have been a `path`-based resume. A same-session dirty-worktree
# resume via `path` never reaches this hook at all.
#
# Fails open on any infrastructure error (missing node, missing script, repo
# not found, malformed hook input) — this must never wedge a legitimate
# EnterWorktree call. Escape hatch if this hook itself misbehaves in
# production: ENTERWORKTREE_GUARD_DISABLE=1 (mirrors the REVIEW_GATE_DISABLE
# convention in pre-push-review-gate.sh).

[ -n "$ENTERWORKTREE_GUARD_DISABLE" ] && exit 0

REPO_ROOT="${BROADWAYSCORE_REPO:-$HOME/Broadwayscore}"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-worktree-collision.js"

[ -f "$CHECK_SCRIPT" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

input=$(cat)
name=$(echo "$input" | jq -r '.tool_input.name // empty' 2>/dev/null)

# No name (random-generated or path-based entry) — nothing to collide on.
[ -z "$name" ] && exit 0

result=$(node "$CHECK_SCRIPT" "$name" 2>/dev/null)
code=$?

# Belt-and-suspenders: block ONLY on exit 1 AND a stdout line that actually
# starts with "REFUSE:" (the script's own contract). check-worktree-collision.js
# reserves exit 3 for unexpected errors precisely so a crash can never look
# like exit 1, but this second check means even a future regression that
# reintroduces that collision still fails open here instead of wedging
# every EnterWorktree call.
if [ $code -eq 1 ] && printf '%s' "$result" | grep -q '^REFUSE:'; then
  cat >&2 <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛑 BLOCKED: EnterWorktree("$name") would resume a live session's worktree

$result

This is the exact collision that let two agents write the same files
concurrently on card 3a9637c5 (task #542, 2026-07-26/27). Pick a different,
more specific worktree name instead of resuming this one.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
  exit 2
fi

exit 0
