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
trap 'rm -rf "$TMP1" "${TMP2:-}" "${TMP3:-}"' EXIT
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
# No remote configured, so the push itself fails later in the retry loop —
# asserted as POSITIVE evidence the script actually reached and ran that
# loop (not just "no usage error", which a crash or early exit would also
# satisfy — adversarial review finding). "Pre-resolution push (attempt 1)"
# only prints from inside the retry loop's first git_push call.
TMP2=$(mktemp -d)
setup_repo "$TMP2"
out2=$( cd "$TMP2" && PUSH_DEADLINE_SEC=5 bash "$PUSH_SCRIPT" 1 main 2>&1 ); code2=$?
if grep -q "^usage: " <<<"$out2"; then
  echo "FAIL[2]: valid numeric max_retries (1) was rejected as a usage error. Output:"; echo "$out2"; fail=1
elif [ "$code2" -ne 1 ]; then
  echo "FAIL[2]: expected exit 1 (no remote configured), got $code2. Output:"; echo "$out2"; fail=1
elif ! grep -q "Pre-resolution push (attempt 1)" <<<"$out2"; then
  echo "FAIL[2]: guard passed but the retry loop never actually ran. Output:"; echo "$out2"; fail=1
else
  echo "PASS[2]: valid numeric max_retries (1) passes the guard and reaches the real retry loop"
fi

# --- Case 3: leading-zero $1 ("08") is rejected too, not just non-digits ---
# Bash arithmetic treats a leading-0 numeral as OCTAL: "08"/"09" error out
# with "value too great for base" (not valid octal digits) and "010" would
# SILENTLY compute as decimal 8 instead of 10 — both are the same class of
# confusing failure this guard exists to prevent, not just plain non-numeric
# input (adversarial review finding).
TMP3=$(mktemp -d)
setup_repo "$TMP3"
out3=$( cd "$TMP3" && bash "$PUSH_SCRIPT" 08 main 2>&1 ); code3=$?
if [ "$code3" -ne 1 ]; then
  echo "FAIL[3]: expected exit 1 for leading-zero max_retries ('08'), got $code3"; fail=1
elif grep -qi "value too great for base\|unbound variable" <<<"$out3"; then
  echo "FAIL[3]: leading-zero arithmetic hazard still reachable. Output:"; echo "$out3"; fail=1
elif ! grep -q "^usage: " <<<"$out3"; then
  echo "FAIL[3]: exit 1 but no usage message on stderr. Output:"; echo "$out3"; fail=1
else
  echo "PASS[3]: leading-zero max_retries ('08') exits 1 with a usage message, not an octal/arithmetic hazard"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry usage-validation test: FAILED"; exit 1
fi
echo "push-with-retry usage-validation test: OK"
