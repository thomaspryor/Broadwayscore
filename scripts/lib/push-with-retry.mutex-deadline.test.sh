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
# so the deadline clock starts fresh for the actual push/retry work.
#
# This test pre-holds the local push-mutex lock with a live background process (so
# push_mutex_acquire must wait and eventually time out, fail-open, per its own
# design), using a mutex timeout LONGER than the script's deadline — the exact
# "mutex wait alone exceeds the work budget" condition from the incident. It then
# asserts the script still gets a real push attempt afterward instead of aborting
# with "after 0 attempt(s)".
#
# Run: bash scripts/lib/push-with-retry.mutex-deadline.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/push-mutex.sh"
fail=0

TMP=$(mktemp -d)
HOLDER_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t
git -C "$TMP" commit -q --allow-empty -m init
git -C "$TMP" remote add origin "file:///nonexistent/definitely/not/a/repo.git"
printf '{ "ok": 1 }\n' > "$TMP/state.json"
git -C "$TMP" add state.json

# Pre-hold the mutex the same way push_mutex_acquire itself would: a real, live
# process recorded as the holder PID, so this run's push_mutex_acquire call is
# forced to actually wait (not reclaim a stale lock).
LOCKDIR="$(cd "$TMP" && _push_mutex_lock_dir)"
mkdir -p "$LOCKDIR"
sleep 30 &
HOLDER_PID=$!
echo "$HOLDER_PID" > "$LOCKDIR/pid"

# Mutex timeout (3s) deliberately LONGER than the push deadline (2s) — mirrors the
# incident's real ratio (900s mutex timeout vs 240s deadline), just compressed.
start=$SECONDS
out=$( cd "$TMP" && PUSH_LOCK_TIMEOUT_SEC=3 PUSH_DEADLINE_SEC=2 bash "$PUSH_SCRIPT" 20 main 2>&1 ); code=$?
elapsed=$(( SECONDS - start ))

kill "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
rm -rf "$LOCKDIR" 2>/dev/null || true

if ! grep -q "waiting on lock held by pid" <<<"$out"; then
  echo "FAIL[1]: test setup didn't actually force a mutex wait. Output:"; echo "$out"; fail=1
else
  echo "PASS[1]: mutex wait was genuinely exercised (pre-held lock forced a wait)"
fi

if grep -q "after 0 attempt(s)" <<<"$out"; then
  echo "FAIL[2]: deadline exceeded after 0 attempts — mutex wait time ate the entire push budget (task #458 regression). Output:"
  echo "$out"
  fail=1
else
  echo "PASS[2]: script did not abort with zero attempts after the mutex wait"
fi

if ! grep -qE "Push failed \(attempt 1" <<<"$out"; then
  echo "FAIL[3]: no push attempt ever ran after the mutex resolved. Output:"; echo "$out"; fail=1
else
  echo "PASS[3]: at least one real push attempt ran after the mutex wait resolved"
fi

# Sanity ceiling: mutex wait (~3s) + deadline-bounded retry work (~2s) + backoff
# should stay well under a minute — this is a compressed unit test, not a hang.
if [ "$elapsed" -ge 60 ]; then
  echo "FAIL[4]: took ${elapsed}s (>=60s) — unexpectedly slow for a 3s mutex + 2s deadline"; fail=1
else
  echo "PASS[4]: bounded to ${elapsed}s total (mutex wait + deadline-bounded retries)"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry mutex/deadline interaction test: FAILED"; exit 1
fi
echo "push-with-retry mutex/deadline interaction test: OK"
