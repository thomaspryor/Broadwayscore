#!/usr/bin/env bash
# Test for scripts/lib/detect-stale-merge-head.sh (BRO-142, generalized to
# REBASE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD by task #1558). Covers the pure
# classifiers (merge_head_staleness, marker_staleness) and the shared message
# builders across: no marker, fresh, stale, a linked worktree's MERGE_HEAD
# (which lives under the main checkout's .git/worktrees/<name>/, not
# <worktree>/.git/ — the exact gap that made session-start.sh's existing
# stalled-merge block invisible to worktree-launched sessions), CHERRY_PICK_HEAD/
# REVERT_HEAD, and REBASE_HEAD via real conflicting rebases on both the
# interactive (rebase-merge) and apply-based (rebase-apply) backends.
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

# --- Case 7: CHERRY_PICK_HEAD fresh/stale (task #1558) ---
R7="$TMP/repo7"
mkdir -p "$R7"
setup_repo "$R7"
git -C "$R7" rev-parse HEAD > "$(git -C "$R7" rev-parse --path-format=absolute --git-path CHERRY_PICK_HEAD)"
out7=$(marker_staleness "$R7" CHERRY_PICK_HEAD)
if [ "${out7%% *}" != "fresh" ]; then
  echo "FAIL[7a]: expected fresh CHERRY_PICK_HEAD, got '$out7'"; fail=1
else
  echo "PASS[7a]: freshly-written CHERRY_PICK_HEAD classifies as fresh ($out7)"
fi
backdate "$(git -C "$R7" rev-parse --path-format=absolute --git-path CHERRY_PICK_HEAD)" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))"
out7b=$(marker_staleness "$R7" CHERRY_PICK_HEAD)
if [ "${out7b%% *}" != "stale" ]; then
  echo "FAIL[7b]: expected stale CHERRY_PICK_HEAD, got '$out7b'"; fail=1
else
  echo "PASS[7b]: back-dated CHERRY_PICK_HEAD classifies as stale ($out7b)"
fi

# --- Case 8: REVERT_HEAD fresh/stale (task #1558) ---
R8="$TMP/repo8"
mkdir -p "$R8"
setup_repo "$R8"
git -C "$R8" rev-parse HEAD > "$(git -C "$R8" rev-parse --path-format=absolute --git-path REVERT_HEAD)"
out8=$(marker_staleness "$R8" REVERT_HEAD)
if [ "${out8%% *}" != "fresh" ]; then
  echo "FAIL[8a]: expected fresh REVERT_HEAD, got '$out8'"; fail=1
else
  echo "PASS[8a]: freshly-written REVERT_HEAD classifies as fresh ($out8)"
fi
backdate "$(git -C "$R8" rev-parse --path-format=absolute --git-path REVERT_HEAD)" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))"
out8b=$(marker_staleness "$R8" REVERT_HEAD)
if [ "${out8b%% *}" != "stale" ]; then
  echo "FAIL[8b]: expected stale REVERT_HEAD, got '$out8b'"; fail=1
else
  echo "PASS[8b]: back-dated REVERT_HEAD classifies as stale ($out8b)"
fi

# --- Case 9: REBASE_HEAD via a REAL conflicting interactive rebase (task
# #1558) — a hand-written marker file (like cases 7/8) would not exercise the
# rebase-merge-dir resolution or the REBASE_HEAD-vs-dir mtime preference, so
# this constructs an actual stopped-on-conflict rebase. ---
R9="$TMP/repo9"
mkdir -p "$R9"
setup_repo "$R9"
echo a > "$R9/f"; git -C "$R9" add f; git -C "$R9" commit -q -m a
git -C "$R9" checkout -qb feat9
echo feat9 >> "$R9/f"; git -C "$R9" commit -q -am feat9-1
git -C "$R9" checkout -q main
echo main9 >> "$R9/f"; git -C "$R9" commit -q -am main9-change
git -C "$R9" checkout -q feat9
git -C "$R9" rebase main >/dev/null 2>&1  # stops on conflict — exit 1 expected
out9=$(marker_staleness "$R9" REBASE_HEAD)
if [ "${out9%% *}" != "fresh" ]; then
  echo "FAIL[9]: expected fresh REBASE_HEAD from a just-stopped conflicting rebase, got '$out9'"; fail=1
else
  echo "PASS[9]: real conflicting interactive rebase classifies REBASE_HEAD as fresh ($out9)"
fi

# --- Case 10: back-dated REBASE_HEAD (conflict has been sitting stale) ---
R9_HEAD=$(git -C "$R9" rev-parse --path-format=absolute --git-path REBASE_HEAD)
backdate "$R9_HEAD" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))"
out10=$(marker_staleness "$R9" REBASE_HEAD)
if [ "${out10%% *}" != "stale" ]; then
  echo "FAIL[10]: expected stale REBASE_HEAD after back-dating, got '$out10'"; fail=1
else
  echo "PASS[10]: back-dated REBASE_HEAD (conflict-stop file) classifies as stale ($out10)"
fi
git -C "$R9" rebase --abort >/dev/null 2>&1 || true

# --- Case 11: REBASE_HEAD dir-mtime fallback when the REBASE_HEAD file
# itself is absent (task #1558) — simulates a mid-`--exec` step where git has
# removed REBASE_HEAD but rebase-merge/ is still very much in progress. Build
# a synthetic rebase-merge dir (no real rebase needed for this fixture: only
# directory presence + mtime matter to the classifier), back-date it, and
# confirm the fallback uses the DIRECTORY's mtime, not "none". ---
R11="$TMP/repo11"
mkdir -p "$R11"
setup_repo "$R11"
R11_RM=$(git -C "$R11" rev-parse --path-format=absolute --git-path rebase-merge)
mkdir -p "$R11_RM"
echo x > "$R11_RM/git-rebase-todo"  # REBASE_HEAD deliberately absent
out11=$(marker_staleness "$R11" REBASE_HEAD)
if [ "${out11%% *}" != "fresh" ]; then
  echo "FAIL[11a]: expected fresh via rebase-merge dir fallback (no REBASE_HEAD file), got '$out11'"; fail=1
else
  echo "PASS[11a]: rebase-merge dir with no REBASE_HEAD file falls back to dir mtime, fresh ($out11)"
fi
backdate "$R11_RM" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))"
out11b=$(marker_staleness "$R11" REBASE_HEAD)
if [ "${out11b%% *}" != "stale" ]; then
  echo "FAIL[11b]: expected stale via back-dated rebase-merge dir, got '$out11b'"; fail=1
else
  echo "PASS[11b]: back-dated rebase-merge dir (no REBASE_HEAD file) classifies as stale ($out11b)"
fi

# --- Case 11c: REBASE_HEAD file present with NEITHER rebase-merge nor
# rebase-apply directory (ship-check finding, task #1558) — a partial-cleanup
# crash: a process died after removing the state directory but before
# removing REBASE_HEAD. This is exactly the "died mid-operation" scenario the
# whole file exists to catch; requiring the directory too would silently miss
# it. ---
R11C="$TMP/repo11c"
mkdir -p "$R11C"
setup_repo "$R11C"
git -C "$R11C" rev-parse HEAD > "$(git -C "$R11C" rev-parse --path-format=absolute --git-path REBASE_HEAD)"
# deliberately no rebase-merge/ or rebase-apply/ directory
out11c=$(marker_staleness "$R11C" REBASE_HEAD)
if [ "${out11c%% *}" != "fresh" ]; then
  echo "FAIL[11c]: expected fresh REBASE_HEAD file with no state dir, got '$out11c'"; fail=1
else
  echo "PASS[11c]: REBASE_HEAD file with no rebase-merge/rebase-apply dir still detected, fresh ($out11c)"
fi

# --- Case 12: REBASE_HEAD via the rebase-apply (non-interactive) backend
# (task #1558) — `git rebase --apply` forces the older am-based backend,
# which uses .git/rebase-apply/ instead of .git/rebase-merge/. ---
R12="$TMP/repo12"
mkdir -p "$R12"
setup_repo "$R12"
echo a > "$R12/f"; git -C "$R12" add f; git -C "$R12" commit -q -m a
git -C "$R12" checkout -qb feat12
echo feat12 >> "$R12/f"; git -C "$R12" commit -q -am feat12-1
git -C "$R12" checkout -q main
echo main12 >> "$R12/f"; git -C "$R12" commit -q -am main12-change
git -C "$R12" checkout -q feat12
git -C "$R12" rebase --apply main >/dev/null 2>&1  # stops on conflict — exit 1 expected
out12=$(marker_staleness "$R12" REBASE_HEAD)
if [ "${out12%% *}" != "fresh" ]; then
  echo "FAIL[12]: expected fresh REBASE_HEAD via rebase-apply backend, got '$out12'"; fail=1
else
  echo "PASS[12]: rebase-apply (non-interactive) backend resolves REBASE_HEAD as fresh ($out12)"
fi
git -C "$R12" rebase --abort >/dev/null 2>&1 || true

# --- Case 13: no rebase in progress → REBASE_HEAD is "none" ---
out13=$(marker_staleness "$R1" REBASE_HEAD)
if [ "${out13%% *}" != "none" ]; then
  echo "FAIL[13]: expected none when no rebase-merge/rebase-apply dir exists, got '$out13'"; fail=1
else
  echo "PASS[13]: no rebase in progress classifies REBASE_HEAD as none ($out13)"
fi

# --- Case 14: message builder branches the recovery command per marker
# (task #1558) — a hard-coded 'git merge --abort' would be wrong advice for
# a stuck rebase/cherry-pick/revert. ---
msg_rebase=$(marker_staleness_message "$R1" REBASE_HEAD "stale" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))")
msg_cp=$(marker_staleness_message "$R1" CHERRY_PICK_HEAD "stale" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))")
msg_revert=$(marker_staleness_message "$R1" REVERT_HEAD "stale" "$(( STALE_MERGE_HEAD_WARN_SEC + 300 ))")
if ! grep -q "rebase --abort" <<<"$msg_rebase"; then
  echo "FAIL[14a]: REBASE_HEAD message missing 'git rebase --abort'"; fail=1
elif grep -q "merge --abort" <<<"$msg_rebase"; then
  echo "FAIL[14a]: REBASE_HEAD message wrongly suggests 'git merge --abort'"; fail=1
else
  echo "PASS[14a]: REBASE_HEAD message suggests 'git rebase --abort'"
fi
if ! grep -q "cherry-pick --abort" <<<"$msg_cp"; then
  echo "FAIL[14b]: CHERRY_PICK_HEAD message missing 'git cherry-pick --abort'"; fail=1
else
  echo "PASS[14b]: CHERRY_PICK_HEAD message suggests 'git cherry-pick --abort'"
fi
if ! grep -q "revert --abort" <<<"$msg_revert"; then
  echo "FAIL[14c]: REVERT_HEAD message missing 'git revert --abort'"; fail=1
else
  echo "PASS[14c]: REVERT_HEAD message suggests 'git revert --abort'"
fi

if [ "$fail" -ne 0 ]; then
  echo "detect-stale-merge-head test: FAILED"; exit 1
fi
echo "detect-stale-merge-head test: OK"
