#!/usr/bin/env bash
# git_add_safe: stage each pathspec INDEPENDENTLY (BRO-2945, sibling of BRO-1593).
#
# WHY: `git add A B C` is atomic on pathspec failure. If any one path is missing
# (a writer legitimately deleted it) git exits 128 and stages NONE of them, so the
# whole commit step fails or, behind `|| true`, silently drops every file.
#
# Per path:
#   exists, not ignored   -> git add (a real git error is reported and makes the
#                            function return 1, after the remaining paths are staged)
#   exists, ignored       -> warn and skip (unless --force)
#   missing, tracked      -> git --literal-pathspecs rm --cached (stages the deletion)
#   missing, untracked    -> warn and skip
# Warnings never fail the call. No `|| true` masking.
#
# Usage (SOURCE it, do not execute):
#   source scripts/lib/git-add-safe.sh
#   git_add_safe [--force] PATH [PATH ...]
# Contrast with scripts/lib/git-add-existing.sh (executed, best-effort, always exit 0,
# cannot stage deletions). Use this one for new/changed commit steps.

git_add_safe() {
  # Paths are literal filenames: no glob/magic expansion by git (a quoted glob must not untrack live files).
  local force="" rc=0 p
  if [ "$1" = "--force" ] || [ "$1" = "-f" ]; then
    force="--force"
    shift
  fi
  [ "$1" = "--" ] && shift
  for p in "$@"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      if [ -z "$force" ] && ! git --literal-pathspecs ls-files --error-unmatch -- "$p" >/dev/null 2>&1 \
         && git check-ignore -q -- "$p"; then
        echo "git_add_safe: WARNING $p is gitignored, not staged" >&2
        continue
      fi
      if ! git --literal-pathspecs add $force -- "$p"; then
        echo "git_add_safe: ERROR git add failed for $p" >&2
        rc=1
      fi
    elif [ -n "$(git --literal-pathspecs ls-files -- "$p" 2>/dev/null)" ]; then
      if ! git --literal-pathspecs rm --cached -r -q --ignore-unmatch -- "$p"; then
        echo "git_add_safe: ERROR could not stage deletion of $p" >&2
        rc=1
      fi
    else
      echo "git_add_safe: WARNING $p does not exist and is not tracked, skipped" >&2
    fi
  done
  return $rc
}
