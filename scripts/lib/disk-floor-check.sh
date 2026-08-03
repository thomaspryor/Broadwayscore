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
  local self_dir repo_root gc_script free_gb lock_dir

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
    # Non-blocking lock: under the exact failure mode this guards against
    # (disk floor breached), MANY concurrent sessions hit this branch at
    # once. Without serialization every one of them launches its own full
    # ~60-worktree GC scan simultaneously — wasted CPU/IO exactly when the
    # machine can least afford it, plus concurrent `git worktree prune` /
    # cache-delete races (adversarial review, task #968). If another
    # session already holds the lock, skip running GC ourselves (it's
    # already being remediated) rather than blocking this push on it.
    #
    # PID-liveness reclaim (not age-based): a lock whose holder process was
    # killed (SIGKILL, machine sleep, `_timeout` wrapper elsewhere) would
    # otherwise strand every future call in the "skip" branch forever, since
    # `mkdir`-lock cleanup relies on a RETURN trap that never fires on a
    # hard kill. Age-only reclaim was rejected on purpose (matches
    # push-mutex.sh's documented reasoning, task #556): it would let a
    # second GC start concurrently with a first one that's just legitimately
    # slow (~5min on 60+ worktrees), recreating the exact race this lock
    # exists to prevent. Reclaim only when `kill -0` proves the holder is
    # actually dead.
    local lock_holder_pid lock_acquired=0
    lock_dir="/tmp/broadwayscore-disk-floor-gc.lock"
    if mkdir "$lock_dir" 2>/dev/null; then
      lock_acquired=1
    else
      lock_holder_pid=$(cat "$lock_dir/pid" 2>/dev/null) || true
      if [ -n "$lock_holder_pid" ] && ! kill -0 "$lock_holder_pid" 2>/dev/null; then
        echo "⚠️  disk preflight: reclaiming stale GC lock (holder pid $lock_holder_pid is not running)" >&2
        rm -rf "$lock_dir" 2>/dev/null || true
        mkdir "$lock_dir" 2>/dev/null && lock_acquired=1
      fi
    fi

    if [ "$lock_acquired" = "1" ]; then
      echo $$ > "$lock_dir/pid" 2>/dev/null || true
      trap 'rmdir "$lock_dir" 2>/dev/null || rm -rf "$lock_dir" 2>/dev/null' RETURN
      echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor — running emergency worktree GC before git op" >&2
      bash "$gc_script" >>"$repo_root/data/audit/worktree-gc.log" 2>&1 || true
      free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}') || true
      echo "⚠️  disk preflight: free space now ${free_gb:-unknown}GB after GC" >&2
    else
      echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor, but GC already running in another session — skipping" >&2
    fi
  fi
  return 0
}
