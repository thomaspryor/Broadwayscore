#!/usr/bin/env bash
# Regression test for BRO-2279: macOS silently grows
# com.google.Chrome.code_sign_clone under /var/folders/**/X/ (45G observed
# 2026-08-21, pushed the fleet to 483Mi free mid-dispatch-loop). Exercises
# the standalone checker against a fixture tree — never the real
# /var/folders — via CHROME_CLONE_CACHE_SEARCH_ROOT, so this runs safely on
# any machine (including Linux CI, where the script must no-op cleanly).
# Run: bash scripts/check-chrome-clone-cache.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-chrome-clone-cache.sh"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chrome-clone-cache-test-XXXXXX")"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
fail=0

# Fixture path shape matches the real one: <root>/<XX>/<hash>/X/com.google.Chrome.code_sign_clone
OVER_FLOOR_DIR="$FIXTURE_ROOT/__/fakehash1/X/com.google.Chrome.code_sign_clone"
UNDER_FLOOR_DIR="$FIXTURE_ROOT/__/fakehash2/X/com.google.Chrome.code_sign_clone"
mkdir -p "$OVER_FLOOR_DIR" "$UNDER_FLOOR_DIR"
head -c 102400 /dev/zero > "$OVER_FLOOR_DIR/clone.dat"   # 100KB
head -c 1024 /dev/zero > "$UNDER_FLOOR_DIR/clone.dat"    # 1KB
# 50KB floor via the KB-precision test seam: over-floor fixture (100KB)
# clears it, under-floor fixture (1KB) stays well below it.
FLOOR_KB_OVERRIDE=50

# --- Test 1: missing search root fails open (no crash, no error exit) ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT/does-not-exist" bash "$SCRIPT" 2>&1)
code=$?
if [ "$code" -eq 0 ] && grep -qi "no com.google.Chrome.code_sign_clone dirs found" <<<"$out"; then
  echo "PASS[1]: missing search root fails open cleanly"
else
  echo "FAIL[1]: missing search root did not fail open. exit=$code, output:"; echo "$out"; fail=1
fi

# --- Test 2: dry-run flags both fixtures at a 0-floor, leaves them on disk ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_GB=0 bash "$SCRIPT" --dry-run 2>&1)
if grep -q "WOULD-PRUNE.*$OVER_FLOOR_DIR" <<<"$out" && grep -q "WOULD-PRUNE.*$UNDER_FLOOR_DIR" <<<"$out"; then
  echo "PASS[2]: --dry-run flags fixtures at a 0GB floor"
else
  echo "FAIL[2]: dry-run did not flag both fixtures. Output:"; echo "$out"; fail=1
fi
if [ -f "$OVER_FLOOR_DIR/clone.dat" ]; then
  echo "PASS[3]: --dry-run left the fixture file in place"
else
  echo "FAIL[3]: --dry-run deleted a fixture file"; fail=1
fi

# --- Test 3: real run prunes only the fixture over the floor ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_KB="$FLOOR_KB_OVERRIDE" bash "$SCRIPT" 2>&1)
if [ ! -f "$OVER_FLOOR_DIR/clone.dat" ]; then
  echo "PASS[4]: real run pruned the over-floor fixture's contents"
else
  echo "FAIL[4]: over-floor fixture file still present after real run. Output:"; echo "$out"; fail=1
fi
if [ -d "$OVER_FLOOR_DIR" ]; then
  echo "PASS[5]: real run preserved the parent directory (contents-only prune)"
else
  echo "FAIL[5]: real run deleted the parent directory itself"; fail=1
fi
if [ -f "$UNDER_FLOOR_DIR/clone.dat" ]; then
  echo "PASS[6]: real run left the under-floor fixture untouched"
else
  echo "FAIL[6]: real run deleted a fixture that was under the floor"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-chrome-clone-cache test: FAILED"; exit 1
fi
echo "check-chrome-clone-cache test: OK"
