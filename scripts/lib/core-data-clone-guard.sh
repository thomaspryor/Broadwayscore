#!/bin/bash
# core-data-clone-guard.sh — sourced helper (BRO-3337).
#
# $HOME/broadway-scorecard-data is ONE clone shared by every session on the
# machine (data/*.json are symlinks into it). A `git reset --hard origin/main`
# there destroys any other session's uncommitted edits AND its committed-but-
# unpushed commits. Call core_clone_local_work before any reset; it prints the
# reason and returns 0 when the clone holds work a reset would destroy.
#
# Checks only local refs (no fetch). Errs toward refusing: a refusal costs a
# stale data refresh, a wrong "safe" costs another session's work.

core_clone_local_work() {
  local dir="$1" branch dirty
  branch="$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null)"
  if [ "$branch" != "main" ]; then
    echo "it is not on main (HEAD: ${branch:-detached})"
    return 0
  fi
  # Untracked files survive a reset, so only tracked changes count.
  dirty="$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null)"
  if [ -n "$dirty" ]; then
    echo "it has uncommitted changes to $(printf '%s\n' "$dirty" | wc -l | tr -d ' ') tracked file(s)"
    return 0
  fi
  if ! git -C "$dir" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
    echo "it has no origin/main ref to compare against"
    return 0
  fi
  # Commits reachable from HEAD but not from origin/main. In a --depth 1 clone
  # a fetch that moved origin/main leaves the old tip unreachable from it, but
  # that tip came from a fetch, so it is a shallow root; a local commit never
  # is. Drop shallow roots and whatever is left is unpushed work.
  local shallow_file ahead
  shallow_file="$(git -C "$dir" rev-parse --git-path shallow 2>/dev/null)"
  case "$shallow_file" in /*) ;; *) shallow_file="$dir/$shallow_file" ;; esac
  ahead="$(git -C "$dir" rev-list HEAD --not refs/remotes/origin/main 2>/dev/null)" || {
    echo "git rev-list failed, cannot tell whether it holds unpushed commits"
    return 0
  }
  if [ -n "$ahead" ] && [ -s "$shallow_file" ]; then
    ahead="$(printf '%s\n' "$ahead" | grep -vxF -f "$shallow_file" || true)"
  fi
  if [ -n "$ahead" ]; then
    echo "it has $(printf '%s\n' "$ahead" | wc -l | tr -d ' ') local commit(s) not on origin/main (unpushed work)"
    return 0
  fi
  return 1
}
