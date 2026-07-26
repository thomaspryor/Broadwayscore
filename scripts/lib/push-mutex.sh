#!/usr/bin/env bash
# push-mutex.sh — local mutex serializing `git push origin main` across
# concurrent Claude Code sessions on this machine (task #556).
#
# WHY THIS EXISTS
#   Three incidents this session-class (#208, #543, #546) all trace to the
#   same root cause: multiple worktree sessions on this Mac Studio can push/
#   fetch/rebase/merge against origin/main concurrently, with nothing to
#   serialize them. Each incident got an after-the-fact detection fix
#   (ancestor checks, retry loops, survival checks) instead of preventing the
#   race. This mutex closes the race itself; the existing detection logic in
#   push-with-retry.sh / merge-worktree-to-main.sh stays as defense in depth
#   for the (rare) case a caller proceeds without the lock.
#
# LOCK IDENTITY
#   The lock directory lives under `git rev-parse --git-common-dir`, which is
#   IDENTICAL across the main checkout and every `git worktree` of the same
#   repo (that's the whole point of git-common-dir) — so it's a single fixed
#   path shared by all worktree sessions on this clone, not a per-worktree
#   path. A different clone of the repo (different .git) gets its own lock,
#   which is correct: this mutex only needs to serialize sessions that could
#   actually race on the SAME local refs. It has no effect across machines
#   (e.g. separate GitHub Actions runners) — those can't share a local lock
#   file anyway, and aren't the failure mode this task targets.
#
# USAGE
#   source scripts/lib/push-mutex.sh
#   push_mutex_acquire            # call once, before the fetch/rebase/push flow
#   trap '... push_mutex_release ...' EXIT   # release on every exit path
#
# BEHAVIOUR
#   - mkdir is atomic on every filesystem this project runs on (macOS local,
#     Linux CI) — used as the lock primitive instead of flock(1), which isn't
#     installed on stock macOS.
#   - Stale-lock reclaim only ever fires when there is NO live process to race
#     against: either the recorded holder PID is confirmed dead, or no PID was
#     ever recorded (the holder was killed between `mkdir` and writing its PID
#     — see below) and the lock directory itself (whose mtime is set
#     atomically by `mkdir`, so it survives that exact gap) is older than
#     PUSH_LOCK_STALE_SEC. A holder with a confirmed-alive PID is NEVER
#     reclaimed by age alone — doing so would let a second session start
#     pushing while the first is still mid-flight, recreating the exact
#     concurrent-push race this mutex exists to prevent (ship-check finding,
#     task #556: an earlier version reclaimed on age regardless of liveness).
#   - Fails OPEN: a waiter that can't acquire the lock within
#     PUSH_LOCK_TIMEOUT_SEC proceeds WITHOUT it (loud warning), rather than
#     blocking a push indefinitely. Default (900s) is set to comfortably
#     exceed the longest documented legitimate hold time (push-with-retry.sh's
#     PUSH_DEADLINE_SEC, overridden up to 600s by high-churn callers, plus
#     backoff/per-op-timeout overhead) — a shorter default would make waiters
#     give up and race a still-legitimately-running holder in the exact
#     "busy main" scenario this mutex targets (ship-check finding). The
#     existing retry/ancestor-check/survival-check logic in both callers is
#     the backstop for the timeout case.
#   - Idempotent release: push_mutex_release only removes the lock dir if its
#     recorded PID is ours (never deletes a lock another process legitimately
#     holds), and no-ops if we never held it.

PUSH_MUTEX_HELD=0
PUSH_MUTEX_LOCKDIR=""

_push_mutex_common_dir() {
  local dir
  dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -z "$dir" ]; then
    dir=$(git rev-parse --git-common-dir 2>/dev/null)
    case "$dir" in
      /*) : ;;
      "") return 1 ;;
      *) dir="$(cd "$dir" 2>/dev/null && pwd)" ;;
    esac
  fi
  [ -n "$dir" ] || return 1
  echo "$dir"
}

_push_mutex_lock_dir() {
  local common_dir
  common_dir=$(_push_mutex_common_dir) || {
    # git rev-parse failed (not a git repo, corrupted .git, ...) — degrade to a
    # shared /tmp path, but key it to cwd so two UNRELATED callers hitting this
    # fallback for different reasons don't serialize against each other.
    local cwd_hash
    cwd_hash=$(pwd -P 2>/dev/null | cksum | awk '{print $1}')
    echo "/tmp/broadwayscore-push-main-${cwd_hash:-unknown}.lock"
    return
  }
  echo "${common_dir}/broadwayscore-push-main.lock"
}

# Portable directory mtime (epoch seconds). BSD `stat` (macOS) and GNU `stat`
# (Linux CI) take different flags; try both, fail open to 0 (treated as
# "unknown age", never spuriously stale) if neither works.
_push_mutex_dir_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# Acquire the mutex. Sets PUSH_MUTEX_HELD=1 and PUSH_MUTEX_LOCKDIR on success.
# Returns 0 whether or not the lock was actually acquired — callers proceed
# either way (fail-open); check PUSH_MUTEX_HELD if the distinction matters.
push_mutex_acquire() {
  local timeout="${PUSH_LOCK_TIMEOUT_SEC:-900}"
  local stale_after="${PUSH_LOCK_STALE_SEC:-900}"
  local lockdir
  lockdir="$(_push_mutex_lock_dir)"
  local start=$SECONDS
  local warned_wait=0

  while true; do
    if mkdir "$lockdir" 2>/dev/null; then
      echo $$ > "$lockdir/pid" 2>/dev/null || true
      PUSH_MUTEX_HELD=1
      PUSH_MUTEX_LOCKDIR="$lockdir"
      return 0
    fi

    local holder_pid dir_mtime now age
    holder_pid=$(cat "$lockdir/pid" 2>/dev/null || echo "")
    dir_mtime=$(_push_mutex_dir_mtime "$lockdir")
    now=$(date +%s)
    age=$(( now - dir_mtime ))

    if [ -n "$holder_pid" ]; then
      if ! kill -0 "$holder_pid" 2>/dev/null; then
        echo "push-mutex: reclaiming stale lock at $lockdir (holder pid $holder_pid is not running)" >&2
        rm -rf "$lockdir" 2>/dev/null || true
        continue
      fi
      # Holder PID recorded and confirmed alive: never reclaim by age alone.
    elif [ "$dir_mtime" -gt 0 ] 2>/dev/null && [ "$age" -ge "$stale_after" ]; then
      # No PID was ever recorded (holder killed between mkdir and the pid
      # write) AND the lock is old: safe to reclaim — there is no live
      # process we could otherwise be racing against here.
      echo "push-mutex: reclaiming stale lock at $lockdir (no holder pid recorded, age ${age}s >= ${stale_after}s)" >&2
      rm -rf "$lockdir" 2>/dev/null || true
      continue
    fi

    if [ $(( SECONDS - start )) -ge "$timeout" ]; then
      echo "push-mutex: timed out after ${timeout}s waiting for lock held by pid ${holder_pid:-unknown} — proceeding WITHOUT the mutex (fail-open); existing retry/ancestor-check logic remains as defense in depth" >&2
      PUSH_MUTEX_HELD=0
      PUSH_MUTEX_LOCKDIR=""
      return 0
    fi
    if [ "$warned_wait" = 0 ]; then
      echo "push-mutex: waiting on lock held by pid ${holder_pid:-unknown} (timeout ${timeout}s)..." >&2
      warned_wait=1
    fi
    sleep 1
  done
}

# Release the mutex if (and only if) we hold it. Safe to call multiple times
# and safe to call even if push_mutex_acquire was never called.
push_mutex_release() {
  [ "$PUSH_MUTEX_HELD" = "1" ] || return 0
  local lockdir="$PUSH_MUTEX_LOCKDIR"
  [ -n "$lockdir" ] || return 0
  local holder_pid
  holder_pid=$(cat "$lockdir/pid" 2>/dev/null || echo "")
  if [ "$holder_pid" = "$$" ]; then
    rm -rf "$lockdir" 2>/dev/null || true
  fi
  PUSH_MUTEX_HELD=0
  PUSH_MUTEX_LOCKDIR=""
}
