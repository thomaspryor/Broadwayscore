#!/usr/bin/env bash
# Test for scripts/lib/sync-audit-checkout.sh (task #732, generalized to a
# missing plist template + zero test coverage by task #1563).
#
# Covers the four shapes a launchd job's checkout can be in when the shared
# sync gate runs: clean (ff-only succeeds outright), dirty-but-regenerable
# (a non-jsonl data/audit/ snapshot — safe to reset and retry), dirty-and-
# precious (a .jsonl append-only ledger, or any file outside data/audit/ —
# must refuse rather than discard), and genuinely diverged (a local commit
# origin doesn't have — refuse, no reset can fix that).
#
# Run: bash scripts/lib/sync-audit-checkout.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/sync-audit-checkout.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Sets up ORIGIN (bare) + a CLONE that starts even with it, both seeded with
# a data/audit/*.json snapshot and a data/audit/*.jsonl ledger.
setup_pair() {
  local origin="$1" clone="$2"
  git init -q --bare "$origin"
  git init -q -b main "$clone"
  git -C "$clone" config user.email t@t.t
  git -C "$clone" config user.name t
  mkdir -p "$clone/data/audit"
  echo '{"totalShows":1}' > "$clone/data/audit/validation-baseline.json"
  echo '{"ts":"1","showId":"a"}' > "$clone/data/audit/score-history.jsonl"
  echo hello > "$clone/other.txt"
  git -C "$clone" add -A
  git -C "$clone" commit -q -m init
  git -C "$clone" remote add origin "$origin"
  git -C "$clone" push -q origin main
}

# Advances ORIGIN by one commit (as if CI pushed) that touches BOTH tracked
# audit files, so a clean ff-only afterward proves the merge actually landed
# origin's content, not just that it didn't error.
advance_origin() {
  local origin="$1" via="$2"
  git init -q "$via"
  git -C "$via" config user.email ci@ci.ci
  git -C "$via" config user.name ci
  git -C "$via" remote add origin "$origin"
  git -C "$via" fetch -q origin main
  git -C "$via" checkout -q main
  mkdir -p "$via/data/audit"
  echo '{"totalShows":2}' > "$via/data/audit/validation-baseline.json"
  printf '{"ts":"1","showId":"a"}\n{"ts":"2","showId":"b"}\n' > "$via/data/audit/score-history.jsonl"
  echo "hello v2 (from origin)" > "$via/other.txt"
  git -C "$via" add -A
  git -C "$via" commit -q -m "ci: advance"
  git -C "$via" push -q origin main
  rm -rf "$via"
}

# --- Case 1: clean checkout, origin ahead → plain ff-only succeeds ---
O1="$TMP/o1"; C1="$TMP/c1"
setup_pair "$O1" "$C1"
advance_origin "$O1" "$TMP/via1"
out1=$(bash "$LIB" "$C1" 2>&1); rc1=$?
head1=$(git -C "$C1" rev-parse HEAD)
origin_head1=$(git -C "$C1" rev-parse origin/main)
if [ "$rc1" -ne 0 ]; then
  echo "FAIL[1]: expected exit 0 on clean ff-only, got $rc1. Output:"; echo "$out1"; fail=1
elif [ "$head1" != "$origin_head1" ]; then
  echo "FAIL[1]: expected HEAD to fast-forward to origin/main"; fail=1
else
  echo "PASS[1]: clean checkout fast-forwards cleanly ($rc1)"
fi

# --- Case 2: dirty non-jsonl snapshot only → resets it and recovers ---
O2="$TMP/o2"; C2="$TMP/c2"
setup_pair "$O2" "$C2"
advance_origin "$O2" "$TMP/via2"
echo '{"totalShows":999,"local":true}' > "$C2/data/audit/validation-baseline.json"
out2=$(SYNC_TAG=case2 bash "$LIB" "$C2" 2>&1); rc2=$?
head2=$(git -C "$C2" rev-parse HEAD)
origin_head2=$(git -C "$C2" rev-parse origin/main)
dirty2=$(git -C "$C2" status --porcelain)
if [ "$rc2" -ne 0 ]; then
  echo "FAIL[2]: expected exit 0 after auto-recovery, got $rc2. Output:"; echo "$out2"; fail=1
elif [ "$head2" != "$origin_head2" ]; then
  echo "FAIL[2]: expected HEAD to reach origin/main after reset+retry"; fail=1
elif [ -n "$dirty2" ]; then
  echo "FAIL[2]: expected a clean tree after recovery, got: $dirty2"; fail=1
elif [ -e "$C2/data/audit/sync-refused-case2.json" ]; then
  echo "FAIL[2]: expected no refusal snapshot after a successful recovery"; fail=1
else
  echo "PASS[2]: dirty regenerable snapshot auto-resets and recovers, no refusal snapshot written ($rc2)"
fi

# --- Case 3: dirty .jsonl ledger → refuses (would lose an append-only entry) ---
O3="$TMP/o3"; C3="$TMP/c3"
setup_pair "$O3" "$C3"
advance_origin "$O3" "$TMP/via3"
printf '{"ts":"1","showId":"a"}\n{"ts":"local-only","showId":"z"}\n' > "$C3/data/audit/score-history.jsonl"
out3=$(SYNC_TAG=case3 bash "$LIB" "$C3" 2>&1); rc3=$?
head3=$(git -C "$C3" rev-parse HEAD)
origin_head3=$(git -C "$C3" rev-parse origin/main)
local_entry3=$(grep -c "local-only" "$C3/data/audit/score-history.jsonl" || true)
snap3="$C3/data/audit/sync-refused-case3.json"
if [ "$rc3" -eq 0 ]; then
  echo "FAIL[3]: expected non-zero exit refusing a dirty .jsonl ledger, got 0. Output:"; echo "$out3"; fail=1
elif [ "$head3" = "$origin_head3" ]; then
  echo "FAIL[3]: expected HEAD to stay behind (refused), but it advanced"; fail=1
elif [ "$local_entry3" -ne 1 ]; then
  echo "FAIL[3]: expected the local-only jsonl line to survive untouched (never discarded)"; fail=1
elif ! grep -qi "refus" <<<"$out3"; then
  echo "FAIL[3]: expected a visible refusal message, got:"; echo "$out3"; fail=1
elif [ ! -f "$snap3" ]; then
  echo "FAIL[3]: expected a visible-alert snapshot at $snap3 (the /tmp log line alone is not a visible alert)"; fail=1
elif ! grep -q '"reason": "dirty-jsonl-ledger"' "$snap3"; then
  echo "FAIL[3]: expected reason=dirty-jsonl-ledger in $snap3, got:"; cat "$snap3"; fail=1
else
  echo "PASS[3]: dirty jsonl ledger is refused loudly, local append preserved, alert snapshot written ($rc3)"
fi

# --- Case 4: dirty file OUTSIDE data/audit/ → refuses, never touches it ---
O4="$TMP/o4"; C4="$TMP/c4"
setup_pair "$O4" "$C4"
advance_origin "$O4" "$TMP/via4"
echo "local edit — work in progress" > "$C4/other.txt"
out4=$(SYNC_TAG=case4 bash "$LIB" "$C4" 2>&1); rc4=$?
head4=$(git -C "$C4" rev-parse HEAD)
origin_head4=$(git -C "$C4" rev-parse origin/main)
other4=$(cat "$C4/other.txt")
snap4="$C4/data/audit/sync-refused-case4.json"
if [ "$rc4" -eq 0 ]; then
  echo "FAIL[4]: expected non-zero exit refusing a dirty non-audit file, got 0. Output:"; echo "$out4"; fail=1
elif [ "$head4" = "$origin_head4" ]; then
  echo "FAIL[4]: expected HEAD to stay behind (refused), but it advanced"; fail=1
elif [ "$other4" != "local edit — work in progress" ]; then
  echo "FAIL[4]: expected the non-audit dirty file to be left untouched, got: $other4"; fail=1
elif ! grep -q '"reason": "dirty-outside-audit"' "$snap4"; then
  echo "FAIL[4]: expected reason=dirty-outside-audit in $snap4, got:"; cat "$snap4" 2>&1; fail=1
else
  echo "PASS[4]: dirty file outside data/audit/ is refused, never auto-reset, alert snapshot written ($rc4)"
fi

# --- Case 4b: case 4's refusal snapshot must clear once the job recovers ---
git -C "$C4" checkout -q HEAD -- other.txt
out4b=$(SYNC_TAG=case4 bash "$LIB" "$C4" 2>&1); rc4b=$?
if [ "$rc4b" -ne 0 ]; then
  echo "FAIL[4b]: expected exit 0 once the blocking file is gone, got $rc4b. Output:"; echo "$out4b"; fail=1
elif [ -e "$snap4" ]; then
  echo "FAIL[4b]: expected the stale refusal snapshot to be cleared on recovery, but $snap4 still exists"; fail=1
else
  echo "PASS[4b]: refusal snapshot cleared once the job recovers ($rc4b)"
fi

# --- Case 5: real divergence (local commit origin lacks), tree clean → refuses ---
O5="$TMP/o5"; C5="$TMP/c5"
setup_pair "$O5" "$C5"
advance_origin "$O5" "$TMP/via5"
echo "diverged" >> "$C5/other.txt"
git -C "$C5" commit -q -am "local-only commit"
out5=$(SYNC_TAG=case5 bash "$LIB" "$C5" 2>&1); rc5=$?
head5=$(git -C "$C5" rev-parse HEAD)
origin_head5=$(git -C "$C5" rev-parse origin/main)
snap5="$C5/data/audit/sync-refused-case5.json"
if [ "$rc5" -eq 0 ]; then
  echo "FAIL[5]: expected non-zero exit on real divergence, got 0. Output:"; echo "$out5"; fail=1
elif [ "$head5" = "$origin_head5" ]; then
  echo "FAIL[5]: expected local commit to be preserved (not discarded), HEAD moved anyway"; fail=1
elif ! grep -q '"reason": "diverged"' "$snap5"; then
  echo "FAIL[5]: expected reason=diverged in $snap5, got:"; cat "$snap5" 2>&1; fail=1
else
  echo "PASS[5]: real divergence (local commit ahead) is refused, not silently swallowed, alert snapshot written ($rc5)"
fi

if [ "$fail" -ne 0 ]; then
  echo "sync-audit-checkout test: FAILED"; exit 1
fi
echo "sync-audit-checkout test: OK"
