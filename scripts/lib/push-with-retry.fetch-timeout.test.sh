#!/usr/bin/env bash
# Integration test for the doubled-fetch-timeout fix (task #464). A parallel
# session found that push-with-retry.sh's mid-loop fetch could hit the full
# GIT_NET_TIMEOUT_SEC=90 cap TWICE back-to-back — once on the explicit-refspec
# fetch, then again on the bare-form fallback retrying the identical operation
# under the identical slow-network condition — starving PUSH_DEADLINE_SEC down
# to ~1.3 real retry cycles under high churn (exact 180s gaps observed in 3 CI
# runs, 2026-07-25/26). The fix: skip the bare-form fallback when the explicit
# form failed with exit 124 (timeout), since a fast rejection (bad refspec) and
# a timeout are different failure modes — only the fast-rejection case still
# benefits from the fallback.
#
# Uses a real silent TCP listener (nc) as the HTTP remote so every git op that
# reaches it actually blocks waiting for a response — a genuine hang, only
# killed by the per-op `_timeout` wrapper (GIT_LOW_SPEED_TIME is left at its
# 45s default, well above this test's short GIT_NET_TIMEOUT_SEC, so the hard
# cap fires first and deterministically produces rc=124 — not git's own
# low-speed abort with some other exit code). NOTE: git's ext:: transport
# (used by push-with-retry.deadline.test.sh Case 3 for a similar hang) turned
# out NOT to reliably reproduce a hang for a plain `git fetch` here — it fails
# instantly with a shell-quoting parse error instead, verified separately —
# so this test uses a different, directly-verified mechanism. Requires a
# `timeout`/`gtimeout` binary (the wrapper fails OPEN without one, per its own
# documented design) and `nc` — SKIP on hosts lacking either rather than hang
# the suite.
# Run: bash scripts/lib/push-with-retry.fetch-timeout.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
  echo "SKIP: no timeout/gtimeout binary — per-op hard kill unavailable here (fail-open by design)"
  echo "push-with-retry fetch-timeout test: OK (skipped)"
  exit 0
fi
if ! command -v nc >/dev/null 2>&1; then
  echo "SKIP: no nc binary — cannot simulate a silent remote here"
  echo "push-with-retry fetch-timeout test: OK (skipped)"
  exit 0
fi

TMP=$(mktemp -d)
PORT=$(( 20000 + (RANDOM % 20000) ))
NC_PID=""
cleanup() { [ -n "$NC_PID" ] && kill "$NC_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# Silent listener: accepts the TCP connection, sends nothing back, ever. `nc`
# closes the connection as soon as its OWN stdin hits EOF — feeding it
# /dev/null (instant EOF) makes it hang up immediately ("Empty reply from
# server"), not hang. A FIFO held open on fd 3 never reaches EOF, so nc just
# forwards the client's request to /dev/null and never writes anything back.
# The outer loop re-accepts so it survives the per-op timeout killing one
# attempt's connection.
mkfifo "$TMP/fifo"
exec 3<>"$TMP/fifo"
( while true; do nc -l "$PORT" <&3 >/dev/null 2>&1; done ) &
NC_PID=$!
sleep 0.3   # let the listener bind before git tries to connect

git -C "$TMP" init -q
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t
git -C "$TMP" remote add origin "http://127.0.0.1:$PORT/silent.git"
git -C "$TMP" commit -q --allow-empty -m init
printf '{ "ok": 1 }\n' > "$TMP/state.json"
git -C "$TMP" add state.json

# MAX_RETRIES=1 isolates a single loop iteration: 1 push attempt + the fetch
# block. GIT_NET_TIMEOUT_SEC=2 keeps the test fast. PUSH_DEADLINE_SEC generous
# so the deadline guard (tested elsewhere) doesn't short-circuit before the
# fetch block runs.
start=$SECONDS
out=$( cd "$TMP" && GIT_NET_TIMEOUT_SEC=2 PUSH_DEADLINE_SEC=60 bash "$PUSH_SCRIPT" 1 main 2>&1 ); code=$?
elapsed=$(( SECONDS - start ))

if ! grep -q "fetch(explicit-refspec) FAILED" <<<"$out"; then
  echo "FAIL[1]: explicit-refspec fetch attempt not logged. Output:"; echo "$out"; fail=1
else
  echo "PASS[1]: explicit-refspec fetch attempted and logged"
fi

if ! grep -q "Skipping bare-form fallback fetch" <<<"$out"; then
  echo "FAIL[2]: timeout (rc=124) did not trigger the fallback-skip message. Output:"; echo "$out"; fail=1
else
  echo "PASS[2]: timeout on explicit-refspec fetch triggered fallback-skip"
fi

if grep -q "fetch(bare-form fallback)" <<<"$out"; then
  echo "FAIL[3]: bare-form fallback fetch ran despite explicit form timing out — the doubled-timeout this fix targets is back. Output:"; echo "$out"; fail=1
else
  echo "PASS[3]: bare-form fallback fetch correctly NOT attempted after a timeout"
fi

# Bound: 1 push timeout (2s) + 1 fetch timeout (2s) + backoff (~5-9s for i=1) +
# process overhead. Without the fix a 2nd fetch timeout would add ~2s more.
# Generous ceiling for CI variance; the precise assertion is the log check above.
if [ "$elapsed" -ge 30 ]; then
  echo "FAIL[4]: took ${elapsed}s — doubled-timeout may still be occurring"; fail=1
else
  echo "PASS[4]: bounded to ${elapsed}s (single fetch timeout, not doubled)"
fi

if [ "$code" -eq 0 ]; then
  echo "FAIL[5]: push unexpectedly succeeded against a sleeping transport (code $code)"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry fetch-timeout test: FAILED"; exit 1
fi
echo "push-with-retry fetch-timeout test: OK"
