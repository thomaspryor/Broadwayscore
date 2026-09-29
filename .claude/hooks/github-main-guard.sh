#!/usr/bin/env bash
# PreToolUse hook for GitHub MCP writes (BRO-4238): sessions never change
# thomaspryor/Broadwayscore's main outside the land flow.
#
# The Bash push gate (pre-push-review-gate.sh) refuses `git push … main`, but
# the GitHub MCP connector writes server-side and never runs a git hook:
#   - create_or_update_file / push_files / delete_file with branch=main
#     commit straight to main;
#   - merge_pull_request / enable_pr_auto_merge merge a PR server-side, skipping
#     land.yml's gates. The PR's base branch is not in the tool input, so they
#     are refused for this repo outright (PRs here target main).
# Sessions land instead: `git push origin HEAD:refs/heads/land/<name>` (or
# create a land/<name> branch with the MCP tools) and follow the Land run.
#
# No Mac master: this file has no ~/.claude/hooks twin, so it also runs on the
# Mac, where the same rule holds (Mac sessions land via
# scripts/merge-worktree-to-main.sh).
#
# Emergency override (an MCP call cannot carry an env prefix): create the file
# $HOME/.claude/LAND_ENFORCE_OFF, or run the session with LAND_ENFORCE_OFF=1.
# Fails open on any parse error.

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
case "$tool_name" in
  mcp__github__create_or_update_file|mcp__github__push_files|mcp__github__delete_file|mcp__github__merge_pull_request|mcp__github__enable_pr_auto_merge) ;;
  *) exit 0 ;;
esac

[ "${LAND_ENFORCE_OFF:-0}" = "1" ] && exit 0
[ -e "$HOME/.claude/LAND_ENFORCE_OFF" ] && exit 0

# Normalize: GitHub resolves owner/repo case-insensitively, and tolerates
# surrounding spaces and a trailing .git.
owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
repo=$(printf '%s' "$input" | jq -r '.tool_input.repo // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
repo=${repo%.git}
[ "$owner/$repo" = "thomaspryor/broadwayscore" ] || exit 0

case "$tool_name" in
  mcp__github__merge_pull_request|mcp__github__enable_pr_auto_merge)
    echo "🛑 BLOCKED: PRs in thomaspryor/Broadwayscore are never merged directly (BRO-4238): a server-side merge skips land.yml's gates. Land the branch instead: git push origin HEAD:refs/heads/land/<name> (or create a land/<name> branch at the PR head with the GitHub tools), follow the Land run, then close the PR. Emergency override: create \$HOME/.claude/LAND_ENFORCE_OFF." >&2
    exit 2 ;;
esac

branch=$(printf '%s' "$input" | jq -r '.tool_input.branch // empty' 2>/dev/null | tr -d '[:space:]')
branch=${branch#refs/}; branch=${branch#heads/}
case "$branch" in
  main)
    echo "🛑 BLOCKED: GitHub-tool writes to thomaspryor/Broadwayscore main are refused (BRO-4238); they skip land.yml's gates. Write to a land/<name> branch instead (land.yml gates it and fast-forwards main), then follow the Land run. Emergency override: create \$HOME/.claude/LAND_ENFORCE_OFF." >&2
    exit 2 ;;
esac
exit 0
