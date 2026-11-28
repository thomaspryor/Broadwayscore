#!/usr/bin/env bash
# Visual-QA push gate for GitHub MCP file writes (BRO-2394), called by
# .claude/hooks/github-main-guard.sh (same PreToolUse matcher) once its own
# main-branch checks pass. Lives in scripts/lib, not .claude/hooks, so the
# hook-set ceiling in scripts/V1-V3-dispatch-status.test.mjs holds. Reads the
# hook input JSON on stdin.
#
# pre-push-visual-gate.sh is matched on Bash only, so a cloud session that
# commits UI files with mcp__github__push_files / create_or_update_file skips
# it entirely. This adapter turns such a write into the equivalent Bash push
# input and runs the existing gate, so there is one visual-QA policy, not two.
#
# Not adapted, on purpose: pre-push-review-gate.sh gates main-bound pushes
# only (land/* is deliberately exempt, and the cloud finish chain requires the
# review), and github-main-guard.sh already refuses MCP writes to main and MCP
# merges. check-skill-redaction.sh fails open wherever its gitignored denylist
# is absent, which is every cloud session, so an MCP twin would never fire.
#
# ADVISORY until promoted (CLAUDE.md §19): when the gate would block, this
# hands its reason to the model as additionalContext, logs the hit to
# $HOME/.claude/logs/mcp-push-visual-gate.log (the false-positive count for
# promotion) and allows the write. Side effect even in advisory mode: the gate
# consumes a pending "ship immediately for:" override, as a git push would. Enforce with
# MCP_PUSH_GATES_ENFORCE=1 or the file $HOME/.claude/MCP_PUSH_GATES_ENFORCE.
# The gate reads the LOCAL diff origin/main...HEAD for its verdict, so it
# matches a session pushing its own committed work; payload paths only decide
# whether the gate runs at all.
#
# Bypass: put "NO-VERIFY: <reason>" in the commit message; it becomes the
# gate's in-command `# NO-VERIFY:` comment (the transcript channel is not
# readable at PreToolUse time). Fails open on any parse error. Disable:
# VISUAL_QA_DISABLE=1 (the gate's own).
# LAND_ENFORCE_OFF skips it too: github-main-guard.sh exits before calling.
# Tests: scripts/tests/github-mcp-push-gates.test.mjs.

# Must stay identical to UI_PATTERN in pre-push-visual-gate.sh (test asserts it).
UI_PATTERN='^(src/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.)'

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
case "$tool_name" in
  mcp__github__create_or_update_file|mcp__github__push_files|mcp__github__delete_file) ;;
  *) exit 0 ;;
esac

owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
repo=$(printf '%s' "$input" | jq -r '.tool_input.repo // empty' 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
repo=${repo%.git}
[ "$owner/$repo" = "thomaspryor/broadwayscore" ] || exit 0

paths=$(printf '%s' "$input" | jq -r '(.tool_input.files // [] | .[]? | .path // empty), (.tool_input.path // empty)' 2>/dev/null)
ui_all=$(printf '%s\n' "$paths" | sed 's#^/##' | grep -E "$UI_PATTERN" | sort -u)
[ -z "$ui_all" ] && exit 0
ui_count=$(printf '%s\n' "$ui_all" | grep -c .)
ui_files=$(printf '%s\n' "$ui_all" | head -5)

branch=$(printf '%s' "$input" | jq -r '.tool_input.branch // empty' 2>/dev/null | tr -d '[:space:]')
case "$branch" in refs/heads/*) branch=${branch#refs/heads/} ;; refs/*) branch=${branch#refs/} ;; esac
[ -z "$branch" ] && exit 0

# BRO-6244: the visual-approval flow parks work on visual-hold/* and screenshots on
# visual-evidence/* (scripts/visual-approval.js); neither ever lands without the owner's
# Approve. Same shape as _HOLD_RE in pre-push-visual-gate.sh (a test pins them together).
HOLD_BRANCH_RE='^visual-(hold|evidence)/[A-Za-z0-9._-]+$'
[[ "$branch" =~ $HOLD_BRANCH_RE ]] && exit 0

# The registered copy wins: on the Mac the ~/.claude master, else the repo copy.
GATE=""
# Test seam only: a stub gate is honoured when BSC_HOOK_TEST=1 is also set.
[ "${BSC_HOOK_TEST:-0}" = "1" ] && GATE="${MCP_PUSH_VISUAL_GATE:-}"
if [ -z "$GATE" ]; then
  if [ -f "$HOME/.claude/hooks/pre-push-visual-gate.sh" ]; then
    GATE="$HOME/.claude/hooks/pre-push-visual-gate.sh"
  else
    GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/hooks/pre-push-visual-gate.sh"
  fi
fi
[ -f "$GATE" ] || exit 0

# `git push origin HEAD`, not HEAD:refs/heads/<branch>: the gate diffs HEAD
# against origin/main either way, and a src:dst refspec would be fed to
# rev-parse as a tree path.
cmd="git push origin HEAD"
no_verify=$(printf '%s' "$input" | jq -r '.tool_input.message // empty' 2>/dev/null \
  | grep -oE 'NO-VERIFY:[[:space:]]*[^[:cntrl:]]{15,}' | head -1 | tr -d '#')
[ -n "$no_verify" ] && cmd="$cmd # $no_verify"
synthetic=$(printf '%s' "$input" | jq -c --arg cmd "$cmd" \
  '{tool_name: "Bash", tool_input: {command: $cmd}, session_id, transcript_path, tool_use_id}' 2>/dev/null) || exit 0

gate_err=$(printf '%s' "$synthetic" | bash "$GATE" 2>&1 >/dev/null)
gate_rc=$?
if [ "$gate_rc" -ne 2 ]; then
  # The gate judges this checkout's commits (origin/main...HEAD). UI files the
  # payload carries that are NOT among them were never seen by any visual-QA
  # verdict, so a gate pass says nothing about them (ship-check finding).
  # Unknown base (no origin/main) keeps the old fail-open behaviour.
  local_diff=$(git diff --name-only origin/main...HEAD 2>/dev/null) || exit 0
  unseen=$(comm -23 <(printf '%s\n' "$ui_all") <(printf '%s\n' "$local_diff" | sort -u) | head -5)
  [ -n "$unseen" ] && [ -z "$no_verify" ] || exit 0
  gate_err="UI file(s) in this write are not in this checkout's commits, so no visual-QA verdict covers them: $(printf '%s' "$unseen" | tr '\n' ' ')"
fi

if [ "${MCP_PUSH_GATES_ENFORCE:-0}" = "1" ] || [ -e "$HOME/.claude/MCP_PUSH_GATES_ENFORCE" ]; then
  printf '%s\n' "$gate_err" >&2
  exit 2
fi
files_line=$(printf '%s' "$ui_files" | tr '\n' ' ')
[ "$ui_count" -gt 5 ] && files_line="$files_line(+$((ui_count - 5)) more)"
msg="ADVISORY (BRO-2394, not blocking yet): this GitHub-tool write to $branch carries UI files ($files_line) and the visual-QA push gate would block the same git push. Run /visual-qa before landing, or put NO-VERIFY: <reason> in the commit message. Gate said: $gate_err"
{ mkdir -p "$HOME/.claude/logs" && printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$tool_name" "$branch" "$files_line" \
    >> "$HOME/.claude/logs/mcp-push-visual-gate.log"; } 2>/dev/null
jq -cn --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $m}}'
exit 0
