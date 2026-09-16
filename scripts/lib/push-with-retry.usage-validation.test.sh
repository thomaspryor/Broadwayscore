#!/usr/bin/env bash
# BRO-2554: usage-validation guard for push-with-retry.sh's first positional arg
# (max_retries). Usage is `[max_retries] [branch]`, but a caller assuming
# `[remote] [branch]` (e.g. passing "origin") used to crash deep in an
# arithmetic context ($(( (MAX_RETRIES + 1) / 2 )) a few lines below the
# assignment) with "line N: origin: unbound variable" under `set -u` — a
# non-numeric string in arithmetic context is treated as a variable NAME,
# and that name is unset. Reproduced live 2026-08-30 while pushing BRO-2186's
# fix: `bash push-with-retry.sh origin main` crashed this way.
#
# The fix validates MAX_RETRIES right after its assignment and exits with a
# clear usage message instead. Run: bash scripts/lib/push-with-retry.usage-validation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

setup_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
}

# --- Case 1: non-numeric $1 ("origin" — the exact live-incident mistake) ---
TMP1=$(mktemp -d)
trap 'rm -rf "$TMP1" "${TMP2:-}"' EXIT
setup_repo "$TMP1"
out1=$( cd "$TMP1" && bash "$PUSH_SCRIPT" origin main 2>&1 ); code1=$?
if [ "$code1" -ne 1 ]; then
  echo "FAIL[1]: expected exit 1 for non-numeric max_retries, got $code1"; fail=1
elif grep -qi "unbound variable" <<<"$out1"; then
  echo "FAIL[1]: confusing 'unbound variable' crash still reachable. Output:"; echo "$out1"; fail=1
elif ! grep -q "^usage: " <<<"$out1"; then
  echo "FAIL[1]: exit 1 but no usage message on stderr. Output:"; echo "$out1"; fail=1
else
  echo "PASS[1]: non-numeric max_retries ('origin') exits 1 with a usage message, not 'unbound variable'"
fi

# --- Case 2: valid numeric $1 is unaffected (regression guard) ---
# No remote configured, so the push itself will still fail later in the retry
# loop — the point here is only that a NUMERIC arg passes the new guard and
# reaches that loop instead of being rejected as usage error.
TMP2=$(mktemp -d)
setup_repo "$TMP2"
out2=$( cd "$TMP2" && PUSH_DEADLINE_SEC=2 bash "$PUSH_SCRIPT" 7 main 2>&1 ); code2=$?
if grep -q "^usage: " <<<"$out2"; then
  echo "FAIL[2]: valid numeric max_retries (7) was rejected as a usage error. Output:"; echo "$out2"; fail=1
else
  echo "PASS[2]: valid numeric max_retries (7) passes the guard (exit $code2, no usage error)"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry usage-validation test: FAILED"; exit 1
fi
echo "push-with-retry usage-validation test: OK"
