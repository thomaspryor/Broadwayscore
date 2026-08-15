#!/usr/bin/env bash
# detect-stale-merge-head.sh — classify how old an existing in-progress-
# operation marker (MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD) is,
# so callers that are about to fetch/rebase/merge can refuse to barge into
# state they didn't create, instead of git erroring out confusingly mid-flow
# or (worse) resolving/committing on top of someone else's unfinished operation.
#
# WHY THIS EXISTS (BRO-142, recurrence of #916/#1279/#1445)
#   A MERGE_HEAD left behind on the shared main worktree by a session that
#   died/crashed mid-conflict-resolution has no expiry today: push-with-retry.sh
#   and merge-worktree-to-main.sh only ever check MERGE_HEAD to interpret THEIR
#   OWN `git merge` call after it runs — a check that makes sense mid-flow, but
#   neither script asks "was MERGE_HEAD already here before I touched anything?"
#   at entry. A leftover MERGE_HEAD present when either script STARTS is never
#   this run's own; something else put it there. Confirmed incident: sat
#   2026-08-03 → 2026-08-14+ (11+ days), silently blocking every subsequent
#   session's push.
#
# WHY NO AUTO-RECOVERY (6-reviewer /plan-review, 2026-08-14, unanimous)
#   The original version of this card proposed auto-`git merge --abort` once
#   MERGE_HEAD passed an age threshold. Every reviewer rejected that for v1:
#     - A documented prior incident on this exact repo
#       (memory/feedback_worktree_merge_conflict_stale_detection.md, same
#       2026-08-03 date as the incident that motivated this file) shows a live
#       session can hand-resolve a conflict for hours WITHOUT ever holding
#       scripts/lib/push-mutex.sh's lock — manual `git add`/inspect cycles
#       across many tool calls never call push_mutex_acquire. Age alone cannot
#       safely distinguish "abandoned" from "live", and `git merge --abort`
#       would destroy that session's uncommitted resolution work.
#     - The only place a mutex-liveness check could plug into the two existing
#       scripts is AFTER push_mutex_acquire — at which point the lock is held
#       by the CALLER's own just-acquired, always-live PID, so an "is the
#       mutex live" gate can never see anyone else's hold there. The abort
#       branch would be unreachable at its two real call sites regardless of
#       age (independently found by two reviewers).
#   So this file only detects and describes; it never mutates git state. Every
#   caller decides what "fresh"/"stale" means for itself. Auto-recovery is a
#   deliberately deferred follow-up, once real WARN-frequency/timing data
#   exists to calibrate a safe heuristic.
#
# GENERALIZED TO OTHER IN-PROGRESS MARKERS (task #1558)
#   BRO-142 shipped MERGE_HEAD only, per its reviewed plan's exact scope. Two
#   independent incidents on this repo (2026-08-03, task #946; BRO-142's own
#   recurrence note) showed the SAME class of bug — a shared checkout stuck
#   mid-operation, blocking every session that tries to merge/push through it
#   — via an in-progress interactive REBASE instead of a MERGE_HEAD file.
#   marker_staleness/marker_staleness_message below generalize the exact same
#   technique to REBASE_HEAD, CHERRY_PICK_HEAD, and REVERT_HEAD.
#   merge_head_staleness/merge_head_staleness_message remain as thin
#   MERGE_HEAD-only wrappers so no existing caller's call shape changes.
#
# CALLER CONSTRAINT: check once, upfront, never mid-flow
#   push-with-retry.sh performs its OWN `git rebase` as legitimate mid-script
#   behavior (see its REBASE_HEAD/MERGE_HEAD conflict-resolution logic). A
#   marker check must stay a single upfront gate — evaluated once, before the
#   caller's own git operations run — exactly like the existing MERGE_HEAD
#   check. Adding a second/repeated check later in such a script's flow would
#   false-block on that script's OWN in-flight rebase.
#
# USAGE (generic — any of MERGE_HEAD | REBASE_HEAD | CHERRY_PICK_HEAD | REVERT_HEAD)
#   source scripts/lib/detect-stale-merge-head.sh
#   result=$(marker_staleness "$REPO_DIR" REBASE_HEAD)  # "none 0" | "fresh <age>" | "stale <age>"
#   status="${result%% *}"
#   if [ "$status" != "none" ]; then
#     marker_staleness_message "$REPO_DIR" REBASE_HEAD "$status" "${result#* }" >&2
#     ...
#   fi
#
# USAGE (MERGE_HEAD-only backward-compatible wrappers)
#   result=$(merge_head_staleness "$REPO_DIR")
#   status="${result%% *}"
#   if [ "$status" != "none" ]; then
#     merge_head_staleness_message "$REPO_DIR" "$status" "${result#* }" >&2
#     ...
#   fi
#
# marker_staleness/merge_head_staleness are PURE: no git state mutation, no
# file writes, no lock acquisition — safe to call from a read-only hook or
# before deciding whether it's even worth queueing for scripts/lib/push-mutex.sh's
# lock.
#
# The full list of markers this file understands, in the order every caller
# checks them — sourced once here so adding a 5th marker later is a one-line
# change instead of an edit at every call site.
# shellcheck disable=SC2034  # consumed by callers that source this file, not used locally
STALE_MARKER_TYPES="MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD"

# Age (seconds) past which an existing marker is described as "stale" rather
# than "fresh". Purely a wording/urgency signal for callers — nothing in this
# file acts on it. Applies to all 4 marker types (name kept for backward
# compat with any external override). 30 min comfortably exceeds ordinary
# concurrent-session timing jitter (an operation that started moments ago
# elsewhere), while being same-session visible instead of the multi-day
# silence this replaces.
STALE_MERGE_HEAD_WARN_SEC="${STALE_MERGE_HEAD_WARN_SEC:-1800}"

# Portable mtime (epoch seconds) of a single file or directory. Same
# technique as push-mutex.sh's _push_mutex_dir_mtime (task #458): `stat -f`/
# `stat -c` flags diverge in incompatible, non-erroring ways between BSD
# (macOS) and GNU (Linux) stat — `date -r PATH +%s` reads a path's mtime
# identically on both, for files and directories alike.
_merge_head_mtime() {
  date -r "$1" +%s 2>/dev/null || echo 0
}

# _marker_git_path <repo_dir> <git-path-arg>
# Thin wrapper around `git rev-parse --path-format=absolute --git-path`,
# empty string on any failure (missing repo, git not found, etc.) so callers
# can treat "" uniformly as "doesn't resolve" without a separate error path.
_marker_git_path() {
  git -C "$1" rev-parse --path-format=absolute --git-path "$2" 2>/dev/null
}

# _rebase_staleness_path <repo_dir>
# Resolves the file whose mtime represents "how long has this rebase been
# sitting here". NOT simply REBASE_HEAD: empirically (task #1558), REBASE_HEAD
# only exists while a rebase step is STOPPED on conflict — it is absent during
# non-conflicting steps (e.g. mid `--exec`), even though `.git/rebase-merge`
# (interactive backend) or `.git/rebase-apply` (apply-based backend) persists
# for the rebase's entire duration and has its own mtime advanced on every
# step (git rewrites `done`/`git-rebase-todo` each step), so it never
# under-reports a live, progressing rebase as stale. Prefer REBASE_HEAD's own
# mtime when present (a conflict stop is the freshest, most specific signal);
# fall back to the rebase-merge/rebase-apply directory's mtime otherwise.
# Prints the path to stdout, or nothing if no rebase is in progress.
_rebase_staleness_path() {
  local repo_dir="$1" rm_dir ra_dir head_path
  rm_dir=$(_marker_git_path "$repo_dir" rebase-merge)
  ra_dir=$(_marker_git_path "$repo_dir" rebase-apply)
  local dir=""
  if [ -n "$rm_dir" ] && [ -d "$rm_dir" ]; then
    dir="$rm_dir"
  elif [ -n "$ra_dir" ] && [ -d "$ra_dir" ]; then
    dir="$ra_dir"
  else
    return 0
  fi
  head_path=$(_marker_git_path "$repo_dir" REBASE_HEAD)
  if [ -n "$head_path" ] && [ -f "$head_path" ]; then
    echo "$head_path"
  else
    echo "$dir"
  fi
}

# marker_staleness <repo_dir> <marker>
# Prints "<status> <age_sec>" to stdout: status is none|fresh|stale.
# <marker> is one of MERGE_HEAD | REBASE_HEAD | CHERRY_PICK_HEAD | REVERT_HEAD
# (see $STALE_MARKER_TYPES). Resolves paths via `git rev-parse
# --path-format=absolute --git-path`, NOT a hardcoded "$repo_dir/.git/<marker>"
# — a linked worktree's markers live under the main checkout's
# .git/worktrees/<name>/, not <worktree>/.git/ (which doesn't exist, since
# .git is a FILE there, not a directory). This resolves correctly for the
# main checkout and any worktree alike. REBASE_HEAD is special-cased via
# _rebase_staleness_path — see its header for why.
marker_staleness() {
  local repo_dir="$1" marker="$2" path=""
  case "$marker" in
    MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)
      path=$(_marker_git_path "$repo_dir" "$marker")
      [ -n "$path" ] && [ -f "$path" ] || { echo "none 0"; return 0; }
      ;;
    REBASE_HEAD)
      path=$(_rebase_staleness_path "$repo_dir")
      [ -n "$path" ] || { echo "none 0"; return 0; }
      ;;
    *)
      echo "none 0"
      return 0
      ;;
  esac
  local mtime now age
  mtime=$(_merge_head_mtime "$path")
  now=$(date +%s)
  age=$(( now - mtime ))
  [ "$age" -ge 0 ] 2>/dev/null || age=0
  if [ "$age" -ge "$STALE_MERGE_HEAD_WARN_SEC" ]; then
    echo "stale $age"
  else
    echo "fresh $age"
  fi
}

# merge_head_staleness <repo_dir>
# Backward-compatible MERGE_HEAD-only wrapper — every caller written before
# task #1558 keeps working unchanged.
merge_head_staleness() {
  marker_staleness "$1" MERGE_HEAD
}

# marker_staleness_message <repo_dir> <marker> <status> <age_sec>
# Builds the loud, actionable banner text shared by every caller (session-
# start.sh's read-only warning, and the die()/::error:: messages in
# push-with-retry.sh / merge-worktree-to-main.sh) so the guidance stays
# identical everywhere this fires instead of drifting across hand-written
# copies. The recovery command (last line) is derived per-marker — running
# `git merge --abort` while a rebase is stuck errors with "no merge in
# progress", so this must not hard-code one verb for all 4 markers.
marker_staleness_message() {
  local repo_dir="$1" marker="$2" status="$3" age="$4"
  local unmerged age_min verb abort_cmd
  unmerged=$(git -C "$repo_dir" diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/     /')
  age_min=$(( age / 60 ))
  case "$marker" in
    MERGE_HEAD)      verb="merge";       abort_cmd="merge --abort" ;;
    REBASE_HEAD)      verb="rebase";      abort_cmd="rebase --abort" ;;
    CHERRY_PICK_HEAD) verb="cherry-pick"; abort_cmd="cherry-pick --abort" ;;
    REVERT_HEAD)      verb="revert";      abort_cmd="revert --abort" ;;
    *)                verb="$marker";     abort_cmd="status" ;;
  esac
  echo "🛑 $marker present in $repo_dir (age: ${age_min}m, status: $status) — NOT created by this run."
  echo "   Either another session is genuinely mid-$verb right now, or a prior"
  echo "   session died/crashed before finishing one (BRO-142/#1558; same class as #916/#1279/#1445)."
  echo "   Unmerged paths:"
  if [ -n "$unmerged" ]; then echo "$unmerged"; else echo "     (none currently listed — check 'git status' by hand)"; fi
  echo "   If you did not just start a $verb here yourself:"
  echo "     git -C $repo_dir status                 # inspect"
  echo "     git -C $repo_dir $abort_cmd           # abandon it (safe: restores pre-$verb state)"
  echo "   ...or resolve the conflicts + 'git -C $repo_dir commit' to finish it."
}

# merge_head_staleness_message <repo_dir> <status> <age_sec>
# Backward-compatible MERGE_HEAD-only wrapper — every caller written before
# task #1558 keeps working unchanged.
merge_head_staleness_message() {
  marker_staleness_message "$1" MERGE_HEAD "$2" "$3"
}
