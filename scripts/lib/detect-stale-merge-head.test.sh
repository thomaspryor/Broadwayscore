#!/usr/bin/env bash
# Test for scripts/lib/detect-stale-merge-head.sh (BRO-142). Covers the pure
# classifier (merge_head_staleness) and the shared message builder across:
# no MERGE_HEAD, fresh, stale, and a linked worktree's MERGE_HEAD (which lives
# under the main checkout's .git/worktrees/<name>/, not <worktree>/.git/ —
# the exact gap that made session-start.sh's existing stalled-merge block
# invisible to worktree-launched sessions).
# Run: bash scripts/lib/detect-stale-merge-head.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/detect-stale-merge-head.sh"
fail=0

setup_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
}

# touch a file's mtime N seconds in the past, portably (BSD + GNU touch differ)
backdate() {
  local file="$1" seconds_ago="$2"
  local ts
  ts=$(date -v-"${seconds_ago}"S +%Y%m%d%H%M.%S 2>/dev/null) || \
    ts=$(date -d "-${seconds_ago} seconds" +%Y%m%d%H%M.%S 2>/dev/null)
  touch -t "$ts" "$file"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Case 1: no MERGE_HEAD → "none" ---
R1="$TMP/repo1"
mkdir -p "$R1"
setup_repo "$R1"
# shellcheck source=scripts/lib/detect-stale-merge-head.sh
source "$LIB"
out1=$(merge_head_staleness "$R1")
if [ "${out1%% *}" != "none" ]; then
  echo "FAIL[1]: expected 'none', got '$out1'"; fail=1
else
  echo "PASS[1]: no MERGE_HEAD classifies as none ($out1)"
fi

# --- Case 2: fresh MERGE_HEAD (age 0) → "fresh" ---
R2="$TMP/repo2"
mkdir -p "$R2"
setup_repo "$R2"
git -C "$R2" rev-parse HEAD > "$R2/.git/MERGE_HEAD"
out2=$(merge_head_staleness "$R2")
if [ "${out2%% *}" != "fresh" ]; then
  echo "FAIL[2]: expected 'fresh', got '$out2'"; fail=1
else
  echo "PASS[2]: freshly-written MERGE_HEAD classifies as fresh ($out2)"
fi

# --- Case 3: stale MERGE_HEAD (age past STALE_MERGE_HEAD_WARN_SEC) → "stale" ---
R3="$TMP/repo3"
mkdir -p "$R3"
setup_repo "$R3"
git -C "$R3" rev-parse HEAD > "$R3/.git/MERGE_HEAD"
backdate "$R3/.git/MERGE_HEAD" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))"
out3=$(merge_head_staleness "$R3")
if [ "${out3%% *}" != "stale" ]; then
  echo "FAIL[3]: expected 'stale', got '$out3'"; fail=1
else
  age3="${out3#* }"
  if [ "$age3" -lt "$STALE_MERGE_HEAD_WARN_SEC" ]; then
    echo "FAIL[3]: status stale but reported age ($age3) is under the threshold"; fail=1
  else
    echo "PASS[3]: back-dated MERGE_HEAD classifies as stale ($out3)"
  fi
fi

# --- Case 4: env-var threshold override is honoured ---
R4="$TMP/repo4"
mkdir -p "$R4"
setup_repo "$R4"
git -C "$R4" rev-parse HEAD > "$R4/.git/MERGE_HEAD"
backdate "$R4/.git/MERGE_HEAD" 120
out4_default=$(merge_head_staleness "$R4")
out4_override=$(STALE_MERGE_HEAD_WARN_SEC=60 merge_head_staleness "$R4")
if [ "${out4_default%% *}" != "fresh" ]; then
  echo "FAIL[4a]: expected default threshold to call 120s-old 'fresh', got '$out4_default'"; fail=1
elif [ "${out4_override%% *}" != "stale" ]; then
  echo "FAIL[4b]: expected STALE_MERGE_HEAD_WARN_SEC=60 to call 120s-old 'stale', got '$out4_override'"; fail=1
else
  echo "PASS[4]: STALE_MERGE_HEAD_WARN_SEC override changes the classification"
fi

# --- Case 5: linked worktree's MERGE_HEAD (lives under main's .git/worktrees/) ---
R5="$TMP/repo5-main"
mkdir -p "$R5"
setup_repo "$R5"
git -C "$R5" worktree add -q -b wt5 "$TMP/repo5-wt" >/dev/null 2>&1
git -C "$TMP/repo5-wt" rev-parse HEAD > "$(git -C "$TMP/repo5-wt" rev-parse --path-format=absolute --git-path MERGE_HEAD)"
out5=$(merge_head_staleness "$TMP/repo5-wt")
if [ "${out5%% *}" != "fresh" ]; then
  echo "FAIL[5]: expected linked worktree's own MERGE_HEAD to classify as fresh, got '$out5'"; fail=1
else
  echo "PASS[5]: linked worktree's MERGE_HEAD (under main's .git/worktrees/) resolves correctly"
fi

# --- Case 6: message builder includes actionable recovery commands ---
msg=$(merge_head_staleness_message "$R3" "stale" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))")
if ! grep -q "merge --abort" <<<"$msg"; then
  echo "FAIL[6]: message missing 'git merge --abort' recovery command"; fail=1
elif ! grep -q "BRO-142" <<<"$msg"; then
  echo "FAIL[6]: message missing BRO-142 reference"; fail=1
else
  echo "PASS[6]: staleness message includes recovery commands"
fi

if [ "$fail" -ne 0 ]; then
  echo "detect-stale-merge-head test: FAILED"; exit 1
fi
echo "detect-stale-merge-head test: OK"
