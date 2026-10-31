#!/usr/bin/env bash
# Shared guards for scripts that pull/rebase a data checkout before pushing
# (BRO-2254, BRO-3942). Source it; it defines functions only.
#
#   rebase_in_progress            true while a rebase is stopped mid-way.
#                                 Uses `git rev-parse --git-path` so it also
#                                 works when .git is a file (worktrees).
#   range_has_merge_commit U H    true when U..H holds a merge commit. A plain
#                                 `git rebase` (no --rebase-merges) silently
#                                 drops such a commit from HEAD's ancestry
#                                 (BRO-3899; same check as push-with-retry.sh's
#                                 _range_has_merge_commit).
#   guarded_pull_rebase ARGS...   `git pull --rebase ARGS...`. Returns 1, and
#                                 the caller must not stage, commit or push,
#                                 when: a rebase or merge was ALREADY in
#                                 progress or unmerged paths exist (left
#                                 untouched: it may be a person's resolution);
#                                 or the pull stopped mid-rebase on a conflict
#                                 (aborted). A pull that refuses before
#                                 starting because of local changes keeps the
#                                 old `|| true` behaviour (return 0, quietly);
#                                 any other failure (network, auth) also
#                                 returns 0 but with a ::warning::.

rebase_in_progress() {
  local d
  for d in rebase-merge rebase-apply; do
    [ -d "$(git rev-parse --git-path "$d" 2>/dev/null)" ] && return 0
  done
  return 1
}

range_has_merge_commit() {
  git rev-parse --verify --quiet "$1" >/dev/null 2>&1 || return 1
  [ -n "$(git rev-list --merges --max-count=1 "$1..$2" 2>/dev/null || true)" ]
}

unfinished_git_op() {
  rebase_in_progress && return 0
  [ -f "$(git rev-parse --git-path MERGE_HEAD 2>/dev/null)" ] && return 0
  [ -n "$(git diff --name-only --diff-filter=U 2>/dev/null)" ]
}

guarded_pull_rebase() {
  if unfinished_git_op; then
    echo "::error::$(pwd) has an unfinished rebase/merge or unmerged paths — not pulling, committing or pushing on top of it (left as found)"
    return 1
  fi
  local err rc=0
  err=$(mktemp)
  # unbounded-fetch-ok: the depth bound is the caller's, passed through "$@"
  # (sync-review-texts.sh passes $(depth_args), the same shallow-fetch-args.js
  # flags its own pulls use); this wrapper adds no fetch of its own.
  git pull --rebase "$@" 2>"$err" || rc=$?
  cat "$err" >&2
  if [ "$rc" -eq 0 ]; then rm -f "$err"; return 0; fi
  if unfinished_git_op; then
    git rebase --abort >/dev/null 2>&1 || true
    rm -f "$err"
    echo "::error::git pull --rebase $* stopped on a conflict in $(pwd) — aborted it; refusing to commit or push on top of a half-finished rebase"
    return 1
  fi
  if grep -qiE 'unstaged changes|uncommitted changes|local changes|would be overwritten' "$err"; then
    echo "git pull --rebase skipped in $(pwd): local changes not yet committed (the push step pulls again)"
  else
    echo "::warning::git pull --rebase $* failed in $(pwd) (rc=$rc, not a local-changes refusal; see stderr above) — continuing; the push step pulls again"
  fi
  rm -f "$err"
  return 0
}
