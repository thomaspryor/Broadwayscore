#!/usr/bin/env bash
# PreToolUse hook on Edit|Write|NotebookEdit — enforces CLAUDE.md §1's worktree
# rule for cloud/iOS sessions, which have no equivalent local-machine hook.
#
# CLAUDE.md §1: "Worktree scope (MANDATORY for ANY tracked code edit): src/,
# scripts/, .github/workflows/, supabase/, next.config.js, tsconfig.json,
# package.json, CLAUDE.md -> must be in a worktree before the first edit
# (local hooks + parallel CI silently revert uncommitted edits; memory/data
# files can skip)."
#
# Why this exists (2026-08-23): .claude/CLOUD.md documents that 12 local
# user-level hooks, including worktree-enforce, do NOT fire in cloud sandboxes
# (they never mount ~/.claude/). Until now, compliance with the worktree rule
# in a cloud/iOS session depended entirely on the model choosing to read and
# follow the CLAUDE.md text, with zero technical backstop -- unlike every
# other rule in this repo, which either has a hook or a CI gate. The
# project's own CLAUDE.md cites a real incident from this exact gap: "A
# parallel session lost page.tsx/index.ts this way on 2026-04-11."
#
# Self-skip if user-level master exists (local CLI scenario) -- same pattern
# as every other hook in this directory.
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi

[ -n "$WORKTREE_ENFORCE_DISABLE" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)

case "$tool_name" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file_path" ] && exit 0

# Already inside a worktree checkout -- the rule is satisfied regardless of
# which repo-relative path is being touched.
case "$file_path" in
  *"/.claude/worktrees/"*) exit 0 ;;
esac

# Not in a worktree: extract the path relative to the repo root so it can be
# matched against CLAUDE.md's scope list. Anchor on the LAST "/Broadwayscore/"
# segment (repo dir name) rather than requiring an exact prefix match, so this
# works regardless of how deep the sandbox's absolute path nests the checkout.
case "$file_path" in
  */Broadwayscore/*)
    rel_path="${file_path##*/Broadwayscore/}"
    ;;
  *)
    # Path doesn't look like it's inside this repo at all (e.g. /tmp scratch
    # files, other repos in a multi-repo workspace) -- not this hook's concern.
    exit 0
    ;;
esac

in_scope=false
case "$rel_path" in
  src/*|scripts/*|.github/workflows/*|supabase/*) in_scope=true ;;
  next.config.js|tsconfig.json|package.json|CLAUDE.md) in_scope=true ;;
esac

[ "$in_scope" = "false" ] && exit 0

cat >&2 <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛑 BLOCKED: editing tracked code ("$rel_path") outside a worktree

CLAUDE.md §1: any edit under src/, scripts/, .github/workflows/, supabase/,
next.config.js, tsconfig.json, package.json, or CLAUDE.md must happen inside
a worktree -- local git hooks + parallel CI can silently revert uncommitted
edits made directly in the main checkout (real incident: 2026-04-11,
page.tsx/index.ts lost this way).

Call EnterWorktree first, then retry this edit inside the worktree path it
gives you. (memory/, cloud-memory/, and data/ files are exempt -- this only
fires for the tracked-code paths above.)

Bypass for a genuine false positive: WORKTREE_ENFORCE_DISABLE=1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
exit 2
