#!/usr/bin/env bash
# Regression test for task #458 (2026-07-30 finding, card #669): push-with-retry.sh's
# overall PUSH_DEADLINE_SEC clock ($SECONDS) used to start counting from bash startup,
# BEFORE push_mutex_acquire. Under real multi-session push contention, push_mutex_acquire
# can block for a real stretch waiting on another session's lock (its own PUSH_LOCK_
# TIMEOUT_SEC defaults to 900s, deliberately longer than PUSH_DEADLINE_SEC's 240s
# default) — so that wait time was silently spent against the deadline before the
# retry loop ran a single iteration. Reproduced live: "waiting on lock held by pid
# 25008 (timeout 900s)" immediately followed by "deadline 240s exceeded after 0
# attempt(s)" — the push itself never got a chance to run.
#
# Fix: push-with-retry.sh now does `SECONDS=0` right after push_mutex_acquire returns,
# BUT ONLY when the mutex was actually ACQUIRED (PUSH_MUTEX_HELD=1). First cut reset
# unconditionally; an adversarial review caught that push_mutex_acquire also returns
# "success" on FAIL-OPEN (timed out without the lock) — resetting the clock there would
# grant a full fresh work budget to a caller that is explicitly UNPROTECTED, reopening
# the concurrent-push race the mutex exists to prevent. So this test covers BOTH paths:
#   1. Lock holder dies mid-wait -> we ACQUIRE after a real wait -> clock resets,
#      a real push attempt runs.
#   2. Lock holder never dies -> mutex times out FAIL-OPEN -> clock does NOT reset,
#      the script fails fast (safer than burning a full unprotected work budget).
#
# Run: bash scripts/lib/push-with-retry.mutex-deadline.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/push-mutex.sh"
fail=0

setup_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
  git -C "$dir" remote add origin "file:///nonexistent/definitely/not/a/repo.git"
  printf '{ "ok": 1 }\n' > "$dir/state.json"
  git -C "$dir" add state.json
}

# ── Case A: holder dies mid-wait -> we ACQUIRE after a real wait ────────────
TMPA=$(mktemp -d)
HOLDER_A=""
cleanup_a() {
  [ -n "$HOLDER_A" ] && kill "$HOLDER_A" 2>/dev/null || true
  rm -rf "$TMPA"
}
trap cleanup_a EXIT
setup_repo "$TMPA"

LOCKDIR_A="$(cd "$TMPA" && _push_mutex_lock_dir)"
mkdir -p "$LOCKDIR_A"
sleep 30 &
HOLDER_A=$!
echo "$HOLDER_A" > "$LOCKDIR_A/pid"
# Kill the "holder" after ~2s so our wait is real but the lock becomes free
# well before PUSH_LOCK_TIMEOUT_SEC — this exercises the ACQUIRE-after-wait
# path (push_mutex_acquire's stale-reclaim-on-dead-pid branch), not fail-open.
( sleep 2; kill "$HOLDER_A" 2>/dev/null || true ) &
KILLER_A=$!

outA=$( cd "$TMPA" && PUSH_LOCK_TIMEOUT_SEC=10 PUSH_DEADLINE_SEC=2 bash "$PUSH_SCRIPT" 20 main 2>&1 )
wait "$KILLER_A" 2>/dev/null || true
rm -rf "$LOCKDIR_A" 2>/dev/null || true

if ! grep -q "reclaiming stale lock" <<<"$outA"; then
  echo "FAIL[A1]: test setup didn't reproduce a real acquire-after-wait (no reclaim log). Output:"; echo "$outA"; fail=1
else
  echo "PASS[A1]: mutex was genuinely acquired after a real wait (holder died, lock reclaimed)"
fi

if grep -q "after 0 attempt(s)" <<<"$outA"; then
  echo "FAIL[A2]: deadline exceeded after 0 attempts even though the mutex was ACQUIRED — the reset isn't firing on the acquired path. Output:"
  echo "$outA"
  fail=1
else
  echo "PASS[A2]: script did not abort with zero attempts after acquiring the mutex"
fi

if ! grep -qE "Push failed \(attempt 1" <<<"$outA"; then
  echo "FAIL[A3]: no push attempt ran after acquiring the mutex. Output:"; echo "$outA"; fail=1
else
  echo "PASS[A3]: at least one real push attempt ran after acquiring the mutex"
fi

# ── Case B: holder never dies -> mutex FAILS OPEN -> must NOT reset ─────────
TMPB=$(mktemp -d)
HOLDER_B=""
cleanup_b() {
  [ -n "$HOLDER_B" ] && kill "$HOLDER_B" 2>/dev/null || true
  rm -rf "$TMPB"
}
setup_repo "$TMPB"

LOCKDIR_B="$(cd "$TMPB" && _push_mutex_lock_dir)"
mkdir -p "$LOCKDIR_B"
sleep 30 &
HOLDER_B=$!
echo "$HOLDER_B" > "$LOCKDIR_B/pid"
# Holder stays alive for the whole test. PUSH_LOCK_TIMEOUT_SEC (3s) is
# deliberately >= PUSH_DEADLINE_SEC (2s) — mirroring the real 900s-vs-240s
# ratio — so that by the time the mutex fails open, $SECONDS has ALREADY
# reached the deadline. If the clock were reset unconditionally (the bug an
# adversarial review caught), the script would get a full fresh 2s budget
# and attempt an UNPROTECTED push despite never having the lock; correctly
# gated, it must fail fast with zero attempts instead.
outB=$( cd "$TMPB" && PUSH_LOCK_TIMEOUT_SEC=3 PUSH_DEADLINE_SEC=2 bash "$PUSH_SCRIPT" 20 main 2>&1 )

kill "$HOLDER_B" 2>/dev/null || true
HOLDER_B=""
rm -rf "$LOCKDIR_B" 2>/dev/null || true

if ! grep -q "proceeding WITHOUT the mutex" <<<"$outB"; then
  echo "FAIL[B1]: test setup didn't reproduce fail-open (holder never died, timeout never fired). Output:"; echo "$outB"; fail=1
else
  echo "PASS[B1]: mutex genuinely failed open (holder stayed alive past PUSH_LOCK_TIMEOUT_SEC)"
fi

if grep -qE "Push failed \(attempt 1" <<<"$outB"; then
  echo "FAIL[B2]: a push attempt ran after fail-open — the deadline clock was reset for an UNPROTECTED caller, reopening the concurrent-push race the mutex exists to prevent (adversarial review finding). Output:"
  echo "$outB"
  fail=1
elif ! grep -q "after 0 attempt(s)" <<<"$outB"; then
  echo "FAIL[B2]: expected the deadline-exceeded-with-0-attempts fail-fast path, but didn't see it. Output:"
  echo "$outB"
  fail=1
else
  echo "PASS[B2]: no push attempt ran after fail-open — deadline correctly NOT reset for an unprotected caller (fails fast instead)"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry mutex/deadline interaction test: FAILED"; exit 1
fi
echo "push-with-retry mutex/deadline interaction test: OK"
