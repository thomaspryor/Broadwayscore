#!/usr/bin/env bash
# Test for gc-merged-worktrees.sh's own serialization lock (task #968
# follow-up, found via /what-else lens-2 "edges" check: an earlier fix
# locked only inside scripts/lib/disk-floor-check.sh's ensure_disk_floor(),
# which missed the launchd cron's direct invocation of this script — cron
# and a preflight-triggered run could still collide and both launch a full
# ~60-worktree GC scan simultaneously). The lock now lives at the top of
# this script so every invocation path (cron, ensure_disk_floor, manual)
# is serialized from one place.
# Run: bash scripts/gc-merged-worktrees.lock.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/gc-merged-worktrees.sh"
LOCK_DIR="/tmp/broadwayscore-disk-floor-gc.lock"
fail=0

cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT
cleanup

# Case 1: lock held by a LIVE process → this invocation exits immediately
# with SKIP-RUN, without doing any of the (slow, real) worktree scanning.
mkdir -p "$LOCK_DIR"
echo $$ > "$LOCK_DIR/pid"   # this test process is alive for the duration of this check
OUT=$(bash "$SCRIPT" --dry-run 2>&1)
CODE=$?
if grep -q "SKIP-RUN" <<<"$OUT" && [ "$CODE" -eq 0 ]; then
  echo "PASS[1]: live-held lock makes this invocation skip immediately (exit 0, SKIP-RUN logged)"
else
  echo "FAIL[1]: live-held lock did not produce a clean SKIP-RUN (exit $CODE). Output tail:"; tail -5 <<<"$OUT"; fail=1
fi
cleanup

# Case 2: lock held by a DEAD process (simulates a session killed mid-GC —
# machine sleep, SIGKILL, an external timeout wrapper — where the EXIT trap
# that normally cleans up the lock never fires) → the stale lock is
# reclaimed via PID liveness (`kill -0`), not age alone, and this
# invocation proceeds to do real work rather than skipping forever.
# Age-only reclaim was rejected on purpose (push-mutex.sh's documented
# reasoning, task #556): it would let a second GC start concurrently with
# a first one that's just legitimately slow (~5min on 60+ worktrees).
mkdir -p "$LOCK_DIR"
( exit 0 ) & DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null
echo "$DEAD_PID" > "$LOCK_DIR/pid"   # now guaranteed not running
bash "$SCRIPT" --dry-run > /tmp/gc-lock-test-case2.log 2>&1 &
RUN_PID=$!
sleep 2
if kill -0 "$RUN_PID" 2>/dev/null; then
  if grep -q "SKIP-RUN" /tmp/gc-lock-test-case2.log; then
    echo "FAIL[2]: stale lock (dead pid $DEAD_PID) was NOT reclaimed — invocation skipped instead of proceeding"; fail=1
  else
    echo "PASS[2]: stale lock (dead pid $DEAD_PID) reclaimed — invocation proceeded to real work (still running after 2s, no SKIP-RUN)"
  fi
  kill "$RUN_PID" 2>/dev/null
  wait "$RUN_PID" 2>/dev/null
else
  # Finished within 2s (small worktree set on this host) — still valid as
  # long as it didn't skip.
  if grep -q "SKIP-RUN" /tmp/gc-lock-test-case2.log; then
    echo "FAIL[2]: stale lock (dead pid $DEAD_PID) was NOT reclaimed — invocation skipped instead of proceeding"; fail=1
  else
    echo "PASS[2]: stale lock (dead pid $DEAD_PID) reclaimed — invocation completed without skipping"
  fi
fi
rm -f /tmp/gc-lock-test-case2.log
cleanup

if [ "$fail" -ne 0 ]; then
  echo "gc-merged-worktrees lock test: FAILED"; exit 1
fi
echo "gc-merged-worktrees lock test: OK"
