#!/usr/bin/env bash
# Shared disk-floor pre-flight check — sourced by push-with-retry.sh and
# merge-worktree-to-main.sh so a low-disk condition self-heals right before
# the exact operation that needs the space, instead of waiting on
# worktree-gc's cron cadence (task #968: disk hit 100% full mid-day, 117MB
# free, blocked all git ops — 62 parallel worktrees' .next caches filled the
# volume faster than the once-daily 4am GC could catch it).
#
# Fail-open by design: any error here (missing df, missing GC script, CI
# environment) must never block the caller's actual git operation.
#
# Usage: source this file, then call `ensure_disk_floor` once before the
# first network git op.
#   DISK_PREFLIGHT_FLOOR_GB=5   # override the trigger threshold (default 5GB)

ensure_disk_floor() {
  # CI runners don't accumulate local worktree/.next sprawl — nothing to GC.
  [ -n "${GITHUB_ACTIONS:-}" ] && return 0

  local floor_gb="${DISK_PREFLIGHT_FLOOR_GB:-5}"
  local self_dir repo_root gc_script free_gb

  # self_dir = .../scripts/lib (this file's dir) → repo_root is two levels up.
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || return 0
  repo_root="$(cd "$self_dir/../.." 2>/dev/null && pwd)" || return 0
  gc_script="$self_dir/../gc-merged-worktrees.sh"
  [ -f "$gc_script" ] || return 0

  free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')
  [ -n "$free_gb" ] || return 0

  if [ "$free_gb" -lt "$floor_gb" ] 2>/dev/null; then
    echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor — running emergency worktree GC before git op" >&2
    bash "$gc_script" >>"$repo_root/data/audit/worktree-gc.log" 2>&1 || true
    free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')
    echo "⚠️  disk preflight: free space now ${free_gb:-unknown}GB after GC" >&2
  fi
  return 0
}
