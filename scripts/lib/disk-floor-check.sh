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
#   DISK_PREFLIGHT_GC_COOLDOWN_SEC=1800  # min gap between preflight GCs (0 = always)
#   DISK_PREFLIGHT_CRITICAL_GB=1  # below this: synchronous GC, cooldown ignored

ensure_disk_floor() {
  # CI runners don't accumulate local worktree/.next sprawl — nothing to GC.
  [ -n "${GITHUB_ACTIONS:-}" ] && return 0
  # BRO-6592: never from inside a `node --test` run (node sets NODE_TEST_CONTEXT
  # in each test-file process; spawned bash inherits it). A test driving
  # push-with-retry.sh against a tmp fixture must not run the real host's
  # worktree GC (~220s, and it removes real worktrees). Standalone bash suites
  # opt out with DISK_PREFLIGHT_FLOOR_GB=0 (push-with-retry-test-isolation.test.mjs).
  [ -n "${NODE_TEST_CONTEXT:-}" ] && return 0

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
    # BRO-6592: a full GC pass scans every worktree (~220s on the Mac Studio
    # with ~100 of them) and, when nothing is merged+clean, frees 0KB, leaving
    # the disk still under the floor. Before this, EVERY push-with-retry.sh /
    # merge call repeated that scan synchronously before its own deadline clock
    # started (push-with-retry.sh resets SECONDS after the mutex), so a
    # 20s-deadline caller ran 240s. Now:
    #   - cooldown: skip if a preflight GC finished < DISK_PREFLIGHT_GC_COOLDOWN_SEC
    #     ago (stamp in the git common dir, shared by every worktree; written
    #     on completion, so a GC that never ran doesn't start a cooldown);
    #   - only below DISK_PREFLIGHT_CRITICAL_GB (default 1, the task #968
    #     "117MB free, git ops failing" case) does the GC ignore the cooldown
    #     and run synchronously; above it git still works, so the GC runs in
    #     the background and the caller's git op is not held up.
    # Any parse/IO error fails open toward running the GC.
    local cooldown="${DISK_PREFLIGHT_GC_COOLDOWN_SEC:-1800}" critical_gb="${DISK_PREFLIGHT_CRITICAL_GB:-1}"
    local stamp_dir stamp now last
    stamp_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || true
    if [ -z "$stamp_dir" ]; then
      stamp_dir=$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null) || true
      case "$stamp_dir" in /*|'') ;; *) stamp_dir=$(cd "$repo_root" 2>/dev/null && cd "$stamp_dir" 2>/dev/null && pwd) || true ;; esac
    fi
    [ -d "$stamp_dir" ] || stamp_dir="$repo_root/data/audit"
    stamp="$stamp_dir/disk-preflight-gc.stamp"
    now=$(date +%s 2>/dev/null) || true
    last=$(head -c 20 "$stamp" 2>/dev/null | tr -d '[:space:]') || true
    # Digits only, then forced base 10: a "08"-style stamp or env value would
    # otherwise be read as octal and abort the caller under set -e.
    case "$cooldown" in ''|*[!0-9]*) cooldown=1800 ;; esac
    case "$critical_gb" in ''|*[!0-9]*) critical_gb=1 ;; esac
    local critical=0
    [ "$free_gb" -lt "$((10#$critical_gb))" ] 2>/dev/null && critical=1
    case "$now:$last" in
      *[!0-9:]*|:*|*:) ;;
      *) local age=$(( 10#$now - 10#$last ))
         if [ "$critical" = 0 ] && [ "$((10#$cooldown))" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -lt "$((10#$cooldown))" ]; then
           echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor — emergency GC already ran ${age}s ago (cooldown ${cooldown}s), skipping" >&2
           return 0
         fi ;;
    esac
    local log="$repo_root/data/audit/worktree-gc.log"
    if [ "$critical" = 1 ]; then
      echo "⚠️  disk preflight: ${free_gb}GB free < ${critical_gb}GB critical — running emergency worktree GC before git op" >&2
      bash "$gc_script" >>"$log" 2>&1 || true
      { date +%s > "$stamp"; } 2>/dev/null || true
      free_gb=$(df -Pk "$repo_root" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}') || true
      echo "⚠️  disk preflight: free space now ${free_gb:-unknown}GB after GC" >&2
    else
      echo "⚠️  disk preflight: ${free_gb}GB free < ${floor_gb}GB floor — emergency worktree GC started in background (log: data/audit/worktree-gc.log)" >&2
      # All three fds detached so a $(...) capture of the caller's output
      # never waits on the GC.
      ( bash "$gc_script" >>"$log" 2>&1 || true; { date +%s > "$stamp"; } 2>/dev/null || true ) </dev/null >/dev/null 2>&1 &
      disown 2>/dev/null || true
    fi
  fi
  return 0
}
