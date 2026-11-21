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

# The script skips anything modified within CHROME_CLONE_CACHE_STALE_MIN
# minutes (default 2) — a real safety feature (don't delete out from under
# an in-progress Chrome update), but it means freshly-`mkdir`'d fixtures
# would always be skipped unless backdated. GNU `touch -d @epoch` (Linux CI)
# falls back to BSD `date -r` + `touch -t` (macOS) — no single flag works
# on both.
backdate() {
  local target="$1" epoch
  epoch=$(( $(date +%s) - 600 ))
  touch -d "@$epoch" "$target" 2>/dev/null && return 0
  touch -t "$(date -r "$epoch" +%Y%m%d%H%M.%S)" "$target" 2>/dev/null
}

# Fixture path shape matches the real one: <root>/<XX>/<hash>/X/com.google.Chrome.code_sign_clone
OVER_FLOOR_DIR="$FIXTURE_ROOT/__/fakehash1/X/com.google.Chrome.code_sign_clone"
UNDER_FLOOR_DIR="$FIXTURE_ROOT/__/fakehash2/X/com.google.Chrome.code_sign_clone"
mkdir -p "$OVER_FLOOR_DIR" "$UNDER_FLOOR_DIR"
head -c 102400 /dev/zero > "$OVER_FLOOR_DIR/clone.dat"   # 100KB
head -c 1024 /dev/zero > "$UNDER_FLOOR_DIR/clone.dat"    # 1KB
backdate "$OVER_FLOOR_DIR"
backdate "$UNDER_FLOOR_DIR"
# 50KB floor via the KB-precision test seam: over-floor fixture (100KB)
# clears it, under-floor fixture (1KB) stays well below it.
FLOOR_KB_OVERRIDE=50

# --- Test 1: missing search root fails open (no crash, no error exit) ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT/does-not-exist" bash "$SCRIPT" 2>&1)
code=$?
if [ "$code" -eq 0 ] && grep -qi "no \*.code_sign_clone dirs found" <<<"$out"; then
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

# --- Test 4: a fixture exactly at the floor is prune-eligible (skip is `-lt`, strictly under) ---
EQUAL_DIR="$FIXTURE_ROOT/__/fakehash3/X/com.google.Chrome.code_sign_clone"
mkdir -p "$EQUAL_DIR"
head -c 51200 /dev/zero > "$EQUAL_DIR/clone.dat"  # exactly 50KB == FLOOR_KB_OVERRIDE
backdate "$EQUAL_DIR"
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_KB="$FLOOR_KB_OVERRIDE" bash "$SCRIPT" --dry-run 2>&1)
if grep -q "WOULD-PRUNE.*$EQUAL_DIR" <<<"$out"; then
  echo "PASS[4]: a fixture exactly at the floor is treated as prune-eligible"
else
  echo "FAIL[4]: a fixture exactly at the floor was skipped. Output:"; echo "$out"; fail=1
fi

# --- Test 5: a freshly-modified over-floor dir is deferred, not pruned ---
FRESH_DIR="$FIXTURE_ROOT/__/fakehash4/X/com.google.Chrome.code_sign_clone"
mkdir -p "$FRESH_DIR"
head -c 102400 /dev/zero > "$FRESH_DIR/clone.dat"  # over floor, mtime left at "now" (not backdated)
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_KB="$FLOOR_KB_OVERRIDE" bash "$SCRIPT" 2>&1)
if [ -f "$FRESH_DIR/clone.dat" ] && grep -q "SKIP.*$FRESH_DIR" <<<"$out"; then
  echo "PASS[5]: a dir modified <2min ago is deferred, not pruned"
else
  echo "FAIL[5]: a freshly-modified dir was pruned instead of deferred. Output:"; echo "$out"; fail=1
fi

# --- Test 6: real run prunes the whole over-floor (backdated) dir, leaves under-floor alone ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_KB="$FLOOR_KB_OVERRIDE" bash "$SCRIPT" 2>&1)
if [ ! -e "$OVER_FLOOR_DIR" ]; then
  echo "PASS[6]: real run deleted the whole over-floor dir (not just its contents — dotglob-safe)"
else
  echo "FAIL[6]: over-floor dir still present after real run. Output:"; echo "$out"; fail=1
fi
if [ -f "$UNDER_FLOOR_DIR/clone.dat" ]; then
  echo "PASS[7]: real run left the under-floor fixture untouched"
else
  echo "FAIL[7]: real run deleted a fixture that was under the floor"; fail=1
fi

# --- Test 8: CHROME_CLONE_CACHE_DISABLED=true is a hard no-op kill switch ---
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_DISABLED=true bash "$SCRIPT" --dry-run 2>&1)
code=$?
if [ "$code" -eq 0 ] && [ -z "$out" ]; then
  echo "PASS[8]: CHROME_CLONE_CACHE_DISABLED=true short-circuits with no output"
else
  echo "FAIL[8]: kill switch did not short-circuit cleanly. exit=$code, output:"; echo "$out"; fail=1
fi

# --- Test 9: matches any *.code_sign_clone dir, not just Chrome's ---
# com.brave.Browser.code_sign_clone found live on the dev machine at 448M
# (same OS bug, different Chromium browser) — the glob generalizes to catch
# the whole class instead of needing a second bespoke script per browser.
BRAVE_DIR="$FIXTURE_ROOT/__/fakehash5/X/com.brave.Browser.code_sign_clone"
mkdir -p "$BRAVE_DIR"
head -c 102400 /dev/zero > "$BRAVE_DIR/clone.dat"
backdate "$BRAVE_DIR"
out=$(CHROME_CLONE_CACHE_SEARCH_ROOT="$FIXTURE_ROOT" CHROME_CLONE_CACHE_FLOOR_KB="$FLOOR_KB_OVERRIDE" bash "$SCRIPT" --dry-run 2>&1)
if grep -q "WOULD-PRUNE.*$BRAVE_DIR" <<<"$out"; then
  echo "PASS[9]: a non-Chrome *.code_sign_clone dir (Brave) is matched too"
else
  echo "FAIL[9]: non-Chrome code_sign_clone dir was not matched. Output:"; echo "$out"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-chrome-clone-cache test: FAILED"; exit 1
fi
echo "check-chrome-clone-cache test: OK"
