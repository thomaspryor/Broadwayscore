#!/usr/bin/env bash
# detect-stale-merge-head.sh — classify how old an existing .git/MERGE_HEAD is,
# so callers that are about to fetch/rebase/merge can refuse to barge into
# state they didn't create, instead of git erroring out confusingly mid-flow
# or (worse) resolving/committing on top of someone else's unfinished merge.
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
# USAGE
#   source scripts/lib/detect-stale-merge-head.sh
#   result=$(merge_head_staleness "$REPO_DIR")   # "none 0" | "fresh <age>" | "stale <age>"
#   status="${result%% *}"
#   if [ "$status" != "none" ]; then
#     merge_head_staleness_message "$REPO_DIR" "$result" >&2
#     ...
#   fi
#
# merge_head_staleness is PURE: no git state mutation, no file writes, no lock
# acquisition — safe to call from a read-only hook or before deciding whether
# it's even worth queueing for scripts/lib/push-mutex.sh's lock.

# Age (seconds) past which an existing MERGE_HEAD is described as "stale"
# rather than "fresh". Purely a wording/urgency signal for callers — nothing
# in this file acts on it. 30 min comfortably exceeds ordinary concurrent-
# session timing jitter (a merge that started moments ago elsewhere), while
# being same-session visible instead of the multi-day silence this replaces.
STALE_MERGE_HEAD_WARN_SEC="${STALE_MERGE_HEAD_WARN_SEC:-1800}"

# Portable mtime (epoch seconds) of a single file. Same technique as
# push-mutex.sh's _push_mutex_dir_mtime (task #458): `stat -f`/`stat -c` flags
# diverge in incompatible, non-erroring ways between BSD (macOS) and GNU
# (Linux) stat — `date -r FILE +%s` reads a file's mtime identically on both.
_merge_head_mtime() {
  date -r "$1" +%s 2>/dev/null || echo 0
}

# merge_head_staleness <repo_dir>
# Prints "<status> <age_sec>" to stdout: status is none|fresh|stale.
# Resolves the MERGE_HEAD path via `git rev-parse --path-format=absolute
# --git-path`, NOT a hardcoded "$repo_dir/.git/MERGE_HEAD" — a linked
# worktree's MERGE_HEAD lives under the main checkout's
# .git/worktrees/<name>/MERGE_HEAD, not <worktree>/.git/MERGE_HEAD (which
# doesn't exist, since .git is a FILE there, not a directory). This resolves
# correctly for the main checkout and any worktree alike.
merge_head_staleness() {
  local repo_dir="$1"
  local merge_head_path
  merge_head_path=$(git -C "$repo_dir" rev-parse --path-format=absolute --git-path MERGE_HEAD 2>/dev/null) || {
    echo "none 0"
    return 0
  }
  if [ -z "$merge_head_path" ] || [ ! -f "$merge_head_path" ]; then
    echo "none 0"
    return 0
  fi
  local mtime now age
  mtime=$(_merge_head_mtime "$merge_head_path")
  now=$(date +%s)
  age=$(( now - mtime ))
  [ "$age" -ge 0 ] 2>/dev/null || age=0
  if [ "$age" -ge "$STALE_MERGE_HEAD_WARN_SEC" ]; then
    echo "stale $age"
  else
    echo "fresh $age"
  fi
}

# merge_head_staleness_message <repo_dir> <status> <age_sec>
# Builds the loud, actionable banner text shared by every caller (session-
# start.sh's read-only warning, and the die() messages in push-with-retry.sh /
# merge-worktree-to-main.sh) so the guidance stays identical everywhere this
# fires instead of drifting across three hand-written copies.
merge_head_staleness_message() {
  local repo_dir="$1" status="$2" age="$3"
  local unmerged age_min
  unmerged=$(git -C "$repo_dir" diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/     /')
  age_min=$(( age / 60 ))
  echo "🛑 MERGE_HEAD present in $repo_dir (age: ${age_min}m, status: $status) — NOT created by this run."
  echo "   Either another session is genuinely mid-conflict right now, or a prior"
  echo "   session died/crashed before finishing one (BRO-142; same class as #916/#1279/#1445)."
  echo "   Unmerged paths:"
  if [ -n "$unmerged" ]; then echo "$unmerged"; else echo "     (none currently listed — check 'git status' by hand)"; fi
  echo "   If you did not just start a merge here yourself:"
  echo "     git -C $repo_dir status                 # inspect"
  echo "     git -C $repo_dir merge --abort           # abandon it (safe: restores pre-merge state)"
  echo "   ...or resolve the conflicts + 'git -C $repo_dir commit' to finish it."
}
