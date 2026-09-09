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
# Use the WORKTREE_GC_LOCK_DIR seam (BRO-2607) rather than the production lock.
# This test rm -rf's LOCK_DIR in its own cleanup trap; against the production
# path that deletes a live launchd/cron GC's lock and lets two real GCs run
# concurrently, which is exactly what the lock exists to prevent.
LOCK_BASE="$(mktemp -d "${TMPDIR:-/tmp}/gc-lock-test-XXXXXX")"
LOCK_DIR="$LOCK_BASE/lock"
export WORKTREE_GC_LOCK_DIR="$LOCK_DIR"
# Also redirect the audit log. Without this the suite appends fixture lines to
# the TRACKED data/audit/worktree-gc.log, and on a Linux CI runner the
# hardcoded /Users/tompryor path does not exist so every `tee -a` in the script
# spews "No such file or directory" for the whole run.
export WORKTREE_GC_LOG="$LOCK_BASE/worktree-gc.log"
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

# Case 3 (BRO-2607): WORKTREE_GC_LOCK_DIR is an `rm -rf` target, so an
# arbitrary value must be REFUSED, not honoured. A temp-root prefix alone is
# not sufficient — session scratchpads live under /private/tmp. An earlier cut
# of this guard was prefix-only and deleted a real scratchpad directory during
# development; that is the regression this case pins.
CASE3_BASE="$(mktemp -d "${TMPDIR:-/tmp}/gc-lock-case3-XXXXXX")"
VICTIM="$CASE3_BASE/not-a-lock-dir"
mkdir -p "$VICTIM"; echo precious > "$VICTIM/keepme.txt"; echo 999999 > "$VICTIM/pid"
NOWHERE='[{"name":"none","path":"/nonexistent-repo-for-lock-test","worktreeDir":".claude/worktrees","buildArtifactDirs":[]}]'

# WORKTREE_GC_VALIDATE_ONLY exits right after the lock-path decision, before
# any lock is acquired. Without it this case falls back to the PRODUCTION
# lock, takes it, and deletes it in the EXIT trap — which on this machine
# makes a concurrent hourly launchd GC skip a real run.
C3_OUT=$(WORKTREE_GC_VALIDATE_ONLY=1 WORKTREE_GC_LOCK_DIR="$VICTIM" WORKTREE_GC_REPOS_JSON="$NOWHERE" bash "$SCRIPT" --dry-run 2>&1)
if ! grep -q "WORKTREE_GC_LOCK_DIR rejected" <<< "$C3_OUT"; then
  echo "FAIL[3]: a non-lock-shaped WORKTREE_GC_LOCK_DIR was ACCEPTED — it is an rm -rf target"; fail=1
elif [ ! -f "$VICTIM/keepme.txt" ]; then
  echo "FAIL[3]: the rejected path was deleted anyway — real data loss"; fail=1
else
  echo "PASS[3]: non-lock-shaped WORKTREE_GC_LOCK_DIR rejected and its directory left intact"
fi

# ...while a genuinely lock-shaped temp path is still honoured, or the seam
# these tests depend on would be useless.
C3B_OUT=$(WORKTREE_GC_VALIDATE_ONLY=1 WORKTREE_GC_LOCK_DIR="$CASE3_BASE/lock" WORKTREE_GC_REPOS_JSON="$NOWHERE" bash "$SCRIPT" --dry-run 2>&1)
if grep -q "WORKTREE_GC_LOCK_DIR rejected" <<< "$C3B_OUT"; then
  echo "FAIL[4]: a valid temp lock path was rejected — the test seam is broken"; fail=1
else
  echo "PASS[4]: a temp-dir path ending in /lock is accepted"
fi
rm -rf "$CASE3_BASE"

if [ "$fail" -ne 0 ]; then
  echo "gc-merged-worktrees lock test: FAILED"; exit 1
fi
echo "gc-merged-worktrees lock test: OK"
