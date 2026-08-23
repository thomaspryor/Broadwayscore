#!/usr/bin/env bash
# PreToolUse hook on Edit|Write|NotebookEdit|Bash — enforces CLAUDE.md §1's worktree
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
# Design mirrors the local-CLI master (cloud-memory/feedback_worktree_code_
# changes.md) rather than reinventing it: git-based root/worktree detection
# (not string-matching on a hardcoded repo dirname), covers Bash writes
# (redirect/cp/mv/sed -i) in addition to Edit/Write/NotebookEdit, and reads
# NotebookEdit's actual `notebook_path` field. A first draft used substring
# matching on "/Broadwayscore/" and only checked `file_path` -- caught by
# /second-opinion review before it shipped: it silently under-enforced
# NotebookEdit (wrong field name -> always empty -> always allowed) and any
# path containing "Broadwayscore" twice, and it never covered Bash at all.
#
# Self-skip if user-level master exists (local CLI scenario) -- same pattern
# as every other hook in this directory.
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi

[ -n "$WORKTREE_ENFORCE_DISABLE" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)

# in_scope_path REL -- true (rel_path set) if REL (repo-root-relative) falls
# under CLAUDE.md §1's scope list.
is_in_scope() {
  case "$1" in
    src/*|scripts/*|.github/workflows/*|supabase/*) return 0 ;;
    next.config.js|next.config.ts|next.config.mjs|tsconfig.json|package.json|package-lock.json|CLAUDE.md) return 0 ;;
    *) return 1 ;;
  esac
}

# resolve_and_check ABS_PATH -- given an absolute file path, resolves its
# containing directory's git toplevel + common-dir via git itself (the same
# idiom pre-push-review-gate.sh / session-start.sh already use in this repo,
# rather than string-matching a hardcoded repo dirname). Prints nothing;
# sets globals BLOCK=1/0 and REL (relative path, for the message) as a side
# effect. Fails open (BLOCK=0) on any git error -- this hook must never wedge
# on a path git can't reason about (e.g. scratch files outside any repo).
BLOCK=0
REL=""
resolve_and_check() {
  local abs="$1" dir toplevel common_dir main_root
  [ -z "$abs" ] && return
  dir=$(dirname -- "$abs")
  [ -d "$dir" ] || dir="."   # file may not exist yet (Write) -- cwd's repo is still the right context
  toplevel=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return
  # --path-format=absolute (git >=2.31) sidesteps git-common-dir's relative-
  # vs-absolute ambiguity: it's relative ("`.git`") when the repo IS its own
  # common dir (main checkout), but absolute for a linked worktree. A first
  # draft branched on leading "/" to tell those apart and got it wrong for
  # the main-checkout case (dirname of a bare ".git" resolves against the
  # wrong cwd) -- caught by this hook's own test suite before shipping.
  common_dir=$(git -C "$toplevel" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return
  main_root=$(dirname -- "$common_dir")
  [ -z "$main_root" ] && return
  # Already inside a linked worktree (toplevel != the main checkout) -- the
  # rule is satisfied regardless of which repo-relative path is being touched.
  [ "$toplevel" != "$main_root" ] && return
  REL="${abs#"$toplevel"/}"
  [ "$REL" = "$abs" ] && return   # abs wasn't actually under toplevel -- not this repo
  is_in_scope "$REL" && BLOCK=1
}

block_message() {
  cat >&2 <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛑 BLOCKED: editing tracked code ("$1") outside a worktree

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
}

case "$tool_name" in
  Edit|Write)
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    [ -z "$file_path" ] && exit 0
    resolve_and_check "$file_path"
    ;;
  NotebookEdit)
    # NotebookEdit's schema field is notebook_path, not file_path -- a first
    # draft of this hook read file_path here and silently never enforced on
    # NotebookEdit calls (caught in /second-opinion review, 2026-08-23).
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.notebook_path // .tool_input.file_path // empty' 2>/dev/null)
    [ -z "$file_path" ] && exit 0
    resolve_and_check "$file_path"
    ;;
  Bash)
    # Mirrors the local-CLI master's Bash coverage (added 2026-04-12 after
    # incident #2: a session's protected-path edit was made via a redirect,
    # not Edit/Write, and slipped through). Only flags a redirect/cp/mv/sed -i
    # whose TARGET resolves (via resolve_and_check) to an in-scope path
    # outside a worktree -- read-only commands (grep/cat/ls) and paths that
    # only appear inside string args (e.g. `notion-brain.js --notes "..."`)
    # are not matched because we require an adjacent redirect/cp/mv/sed -i
    # operator immediately before the path token.
    command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    [ -z "$command" ] && exit 0
    # Extract candidate target paths. Two shapes, deliberately kept separate:
    #   - >, >>, tee: target is the single token right after the operator.
    #   - cp, mv, sed -i: target is the LAST token of that clause (cp/mv take
    #     SRC... DST; sed -i takes an expression before the file). Taking
    #     $NF of the >/tee match would be wrong here (it'd grab the first
    #     source arg, not the destination) -- caught by this hook's own test
    #     suite (T13/T14 initially failed to block a `cp`/`sed -i` write)
    #     before shipping, so the two cases stay on separate patterns.
    # Deliberately conservative -- false negatives (missed writes) fail open
    # per this hook's design; false positives would wedge an unrelated
    # command with no escape hatch beyond WORKTREE_ENFORCE_DISABLE.
    targets=$(
      {
        printf '%s' "$command" | grep -oE '(^|[[:space:]])(>>?|tee)[[:space:]]+[^[:space:];&|]+' | awk '{print $NF}'
        printf '%s' "$command" | grep -oE '(^|[;&|]|&&|\|\|)[[:space:]]*(cp|mv|sed[[:space:]]+-i[a-zA-Z0-9]*)[[:space:]]+[^;&|]+' | awk '{print $NF}'
      }
    )
    [ -z "$targets" ] && exit 0
    while IFS= read -r t; do
      [ -z "$t" ] && continue
      case "$t" in
        /*) abs="$t" ;;
        *)  abs="$(pwd)/$t" ;;
      esac
      resolve_and_check "$abs"
      [ "$BLOCK" = "1" ] && break
    done <<EOF
$targets
EOF
    ;;
  *) exit 0 ;;
esac

[ "$BLOCK" != "1" ] && exit 0
block_message "$REL"
exit 2
