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

  # Every assignment below is `|| true`-guarded: the caller (push-with-retry.sh,
  # merge-worktree-to-main.sh) runs under `set -euo pipefail`, and `df` piped
  # into `awk` inherits pipefail — a bare `df` hiccup would otherwise make
  # THIS assignment's nonzero exit trip errexit and kill the caller's entire
  # push/merge, the opposite of "fail-open" (adversarial review, task #968).
  free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}') || true
  [ -n "$free_gb" ] || return 0

  if [ "$free_gb" -lt "$floor_gb" ] 2>/dev/null; then
    # Serialization lives INSIDE gc-merged-worktrees.sh itself (task #968
    # follow-up), not here. An earlier version locked only at this call
    # site, which missed the launchd cron's direct invocation of the same
    # script entirely — two sessions could both pass this floor check at
    # once and each spawn a redundant ~60-worktree GC scan simultaneously.
    # The script's own lock now covers every invocation path (cron, this
    # preflight, manual runs) from one place, so this just calls it and
    # trusts it to no-op (SKIP-RUN, exit 0) if another run is in flight.
    echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor — running emergency worktree GC before git op" >&2
    bash "$gc_script" >>"$repo_root/data/audit/worktree-gc.log" 2>&1 || true
    free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}') || true
    echo "⚠️  disk preflight: free space now ${free_gb:-unknown}GB after GC" >&2
  fi
  return 0
}
