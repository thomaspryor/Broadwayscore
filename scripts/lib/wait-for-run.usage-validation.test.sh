#!/usr/bin/env bash
# BRO-2554 what-else sweep: wait-for-run.sh's TIMEOUT_MIN validation had the
# same leading-zero-octal hazard fixed in push-with-retry.sh's MAX_RETRIES
# this same session — "08"/"09" error out ("value too great for base") and
# "010" silently computes as decimal 8 instead of 10 in the
# `TIMEOUT_MIN * 60` arithmetic context, both confusing failures the
# ^[0-9]+$ regex alone did not catch. Run:
#   bash scripts/lib/wait-for-run.usage-validation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/wait-for-run.sh"
fail=0

# --- Case 1: leading-zero timeout-min is rejected with a usage error ---
out1=$(bash "$SCRIPT" 123 08 2>&1); code1=$?
if [ "$code1" -ne 3 ]; then
  echo "FAIL[1]: expected exit 3 for leading-zero timeout-min ('08'), got $code1"; fail=1
elif grep -qi "value too great for base" <<<"$out1"; then
  echo "FAIL[1]: leading-zero arithmetic hazard still reachable. Output:"; echo "$out1"; fail=1
elif ! grep -q "no leading zeros" <<<"$out1"; then
  echo "FAIL[1]: exit 3 but no leading-zero usage message. Output:"; echo "$out1"; fail=1
else
  echo "PASS[1]: leading-zero timeout-min ('08') exits 3 with a usage message, not an octal/arithmetic hazard"
fi

# --- Case 2: non-numeric timeout-min still rejected (pre-existing behavior, regression guard) ---
out2=$(bash "$SCRIPT" 123 abc 2>&1); code2=$?
if [ "$code2" -ne 3 ]; then
  echo "FAIL[2]: expected exit 3 for non-numeric timeout-min, got $code2"; fail=1
else
  echo "PASS[2]: non-numeric timeout-min still rejected (exit 3, unaffected by the leading-zero tightening)"
fi

# --- Case 3: a valid numeric timeout-min still passes validation (regression guard) ---
# Bogus run ID so gh fails fast; the point is only that TIMEOUT_MIN=1 does NOT
# hit the usage-error path.
out3=$(timeout 5 bash "$SCRIPT" 999999999999 1 2>&1)
if grep -q "must be a positive integer" <<<"$out3"; then
  echo "FAIL[3]: valid numeric timeout-min (1) was rejected as a usage error. Output:"; echo "$out3"; fail=1
else
  echo "PASS[3]: valid numeric timeout-min (1) passes validation"
fi

if [ "$fail" -ne 0 ]; then
  echo "wait-for-run usage-validation test: FAILED"; exit 1
fi
echo "wait-for-run usage-validation test: OK"
