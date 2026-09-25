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
elif ! echo "$out5" | grep -q "3-way merge of origin/main"; then
  echo "FAIL[5]: BRO-3393 recovery should have been ATTEMPTED here (clean tree, ahead AND behind) before refusing. Output:"; echo "$out5"; fail=1
elif ! echo "$out5" | grep -q "merge of origin/main failed"; then
  echo "FAIL[5]: expected the attempted merge to conflict and abort, leaving the refusal intact. Output:"; echo "$out5"; fail=1
elif [ -n "$(git -C "$C5" ls-files -u)" ]; then
  echo "FAIL[5]: checkout left mid-merge with unresolved paths — the abort did not clean up"; fail=1
else
  echo "PASS[5]: real content divergence attempts the merge, conflicts, aborts cleanly, and still refuses ($rc5)"
fi

# --- Case 6: UNTRACKED colliding file blocks ff-only → git diff can't see
# it (never staged), but it's a regenerable non-jsonl audit snapshot, so the
# script must remove it and recover (review finding: git diff --name-only is
# untracked-blind, so this path used to be invisible to DIRTY_AUDIT_FILES). ---
O6="$TMP/o6"; C6="$TMP/c6"
setup_pair "$O6" "$C6"
git init -q "$TMP/via6"
git -C "$TMP/via6" config user.email ci@ci.ci
git -C "$TMP/via6" config user.name ci
git -C "$TMP/via6" remote add origin "$O6"
git -C "$TMP/via6" fetch -q origin main
git -C "$TMP/via6" checkout -q main
mkdir -p "$TMP/via6/data/audit"
echo '{"crashed":false}' > "$TMP/via6/data/audit/new-report.json"
git -C "$TMP/via6" add -A
git -C "$TMP/via6" commit -q -m "ci: adds new-report.json"
git -C "$TMP/via6" push -q origin main
rm -rf "$TMP/via6"
mkdir -p "$C6/data/audit"
echo '{"crashed":true,"partial":"write from a killed run"}' > "$C6/data/audit/new-report.json"
out6=$(SYNC_TAG=case6 bash "$LIB" "$C6" 2>&1); rc6=$?
head6=$(git -C "$C6" rev-parse HEAD)
origin_head6=$(git -C "$C6" rev-parse origin/main)
content6=$(cat "$C6/data/audit/new-report.json" 2>/dev/null)
if [ "$rc6" -ne 0 ]; then
  echo "FAIL[6]: expected exit 0 — an untracked regenerable snapshot should self-heal, got $rc6. Output:"; echo "$out6"; fail=1
elif [ "$head6" != "$origin_head6" ]; then
  echo "FAIL[6]: expected HEAD to reach origin/main after untracked-file cleanup"; fail=1
elif [ "$content6" != '{"crashed":false}' ]; then
  echo "FAIL[6]: expected origin's new-report.json content after recovery, got: $content6"; fail=1
else
  echo "PASS[6]: untracked colliding regenerable snapshot is removed and recovered ($rc6)"
fi

# --- Case 7: untracked file OUTSIDE data/audit/ blocks ff-only → refuses,
# reason must NOT be misclassified as "diverged" (review finding: excluding
# untracked files from REMAINING_DIRTY made this indistinguishable from real
# commit divergence). ---
O7="$TMP/o7"; C7="$TMP/c7"
setup_pair "$O7" "$C7"
git init -q "$TMP/via7"
git -C "$TMP/via7" config user.email ci@ci.ci
git -C "$TMP/via7" config user.name ci
git -C "$TMP/via7" remote add origin "$O7"
git -C "$TMP/via7" fetch -q origin main
git -C "$TMP/via7" checkout -q main
echo "new from origin" > "$TMP/via7/brand-new.txt"
git -C "$TMP/via7" add -A
git -C "$TMP/via7" commit -q -m "ci: adds brand-new.txt"
git -C "$TMP/via7" push -q origin main
rm -rf "$TMP/via7"
echo "local uncommitted work, never staged" > "$C7/brand-new.txt"
out7=$(SYNC_TAG=case7 bash "$LIB" "$C7" 2>&1); rc7=$?
snap7="$C7/data/audit/sync-refused-case7.json"
if [ "$rc7" -eq 0 ]; then
  echo "FAIL[7]: expected non-zero exit — untracked file outside data/audit/ must not be discarded, got 0. Output:"; echo "$out7"; fail=1
elif [ ! -f "$snap7" ]; then
  echo "FAIL[7]: expected an alert snapshot at $snap7"; fail=1
elif grep -q '"reason": "diverged"' "$snap7"; then
  echo "FAIL[7]: untracked-file block was misclassified as 'diverged' (the exact bug this case guards), got:"; cat "$snap7"; fail=1
elif ! grep -q '"reason": "dirty-outside-audit"' "$snap7"; then
  echo "FAIL[7]: expected reason=dirty-outside-audit in $snap7, got:"; cat "$snap7"; fail=1
elif ! grep -q "brand-new.txt" "$snap7"; then
  echo "FAIL[7]: expected the blocking untracked file to be named in $snap7, got:"; cat "$snap7"; fail=1
else
  echo "PASS[7]: untracked file outside data/audit/ correctly classified (not misreported as diverged), never discarded ($rc7)"
fi

# ── case 8 (BRO-3393): diverged with a CLEAN tree — recover, do not refuse ──
# A local commit origin lacks, origin has moved, and NOTHING dirty overlaps
# what origin moves. This was terminal before BRO-3393 ("no file to blame and
# no union to attempt"), and it is the state BRO-3212's own commit-and-rebase
# recovery leaves behind when its rebase fails. On the real machine that
# stranded one ledger commit at 2026-09-14 18:30 and every sync-gated launchd
# job refused for 17.5 hours, forcing the morning digest's auto-fix into
# dry-run. The gate must reconcile it with a 3-way merge and exit 0.
#
# The local commit here is a MERGE COMMIT on purpose: a rebase recovery would
# destroy it (verified empirically — the side commits survive with fresh SHAs,
# the merge does not), which is why the recovery is `git merge`, not rebase.
O8="$TMP/origin8"; C8="$TMP/clone8"
setup_pair "$O8" "$C8"
git -C "$C8" checkout -q -b side
echo "session work that never reached origin" > "$C8/session-work.txt"
git -C "$C8" add -A
git -C "$C8" commit -q -m "session: local work"
git -C "$C8" checkout -q main
git -C "$C8" merge -q --no-ff side -m "merge session work"
advance_origin "$O8" "$TMP/via8"
out8=$(SYNC_TAG=case8 bash "$LIB" "$C8" 2>&1); rc8=$?
snap8="$C8/data/audit/sync-refused-case8.json"
if [ "$rc8" -ne 0 ]; then
  echo "FAIL[8]: expected exit 0 — a diverged checkout with nothing blocking the ff is recoverable. Output:"; echo "$out8"; fail=1
elif [ -f "$snap8" ]; then
  echo "FAIL[8]: a recovered run must leave no refusal snapshot, found $snap8:"; cat "$snap8"; fail=1
elif [ ! -f "$C8/session-work.txt" ]; then
  echo "FAIL[8]: the unpushed local commit's content was LOST by the recovery"; fail=1
elif ! git -C "$C8" log --format=%s | grep -q "^merge session work$"; then
  echo "FAIL[8]: the unpushed MERGE COMMIT was rewritten away — recovery must merge, never rebase. Log:"; git -C "$C8" log --oneline | head -5; fail=1
elif [ "$(git -C "$C8" rev-list --count HEAD..origin/main)" != "0" ]; then
  echo "FAIL[8]: checkout is still behind origin/main after recovery"; fail=1
else
  echo "PASS[8]: clean-tree divergence reconciled by merge; local merge commit and its content both intact ($rc8)"
fi

# ── case 9 (BRO-3393): ahead but NOT behind must still be left alone ────────
# classifyBlock's no-blocker branch also catches a fetch/ref problem, where
# origin/main is unreadable or has not moved. `git merge --ff-only origin/main`
# reports "Already up to date" and exits 0 in that state, so the gate must
# never reach the merge recovery at all.
O9="$TMP/origin9"; C9="$TMP/clone9"
setup_pair "$O9" "$C9"
echo "local only" > "$C9/local-only.txt"
git -C "$C9" add -A
git -C "$C9" commit -q -m "local: ahead of origin, origin has not moved"
out9=$(SYNC_TAG=case9 bash "$LIB" "$C9" 2>&1); rc9=$?
snap9="$C9/data/audit/sync-refused-case9.json"
if [ "$rc9" -ne 0 ]; then
  echo "FAIL[9]: ahead-but-not-behind must exit 0 via ff-only 'Already up to date'. Output:"; echo "$out9"; fail=1
elif [ -f "$snap9" ]; then
  echo "FAIL[9]: no refusal snapshot should be written, found $snap9:"; cat "$snap9"; fail=1
elif echo "$out9" | grep -q "3-way merge of origin/main"; then
  echo "FAIL[9]: the merge recovery fired on a checkout that was not behind. Output:"; echo "$out9"; fail=1
else
  echo "PASS[9]: ahead-but-not-behind short-circuits at ff-only, recovery never reached ($rc9)"
fi

# ── case 10 (BRO-3393 ship-check): merge exits 0 but the autostash POP ──────
# conflicts. Verified empirically: git prints "Applying autostash resulted in
# conflicts", EXITS 0, removes MERGE_HEAD, and leaves `UU` unmerged paths plus
# a stranded stash. A bare `if git merge --autostash ...; then recovered` would
# report success and hand every downstream launchd job a checkout with conflict
# markers in a tracked file. The gate must detect it, resolve the paths back to
# the merged commit, keep the content in the stash, and REFUSE.
#
# The race this models: `blockingPaths` is computed before the merge, so a
# concurrent session can dirty an origin-moved file in the window between.
O10="$TMP/origin10"; C10="$TMP/clone10"
setup_pair "$O10" "$C10"
git -C "$C10" commit -q --allow-empty -m "local-only commit (makes us ahead)"
advance_origin "$O10" "$TMP/via10"
# Dirty `other.txt` — which advance_origin also moved on origin — only AFTER
# the decision would have been taken, so the autostash pop is what conflicts.
# The gate itself re-reads the tree, so emulate the race by making the file
# dirty in a way that does not block ff (same content as HEAD until the merge
# rewrites it is impossible here, so instead assert on the OUTCOME contract:
# whatever the gate decides, it must never exit 0 with unmerged paths).
echo "concurrent session edit" > "$C10/other.txt"
out10=$(SYNC_TAG=case10 bash "$LIB" "$C10" 2>&1); rc10=$?
unmerged10=$(git -C "$C10" ls-files -u)
if [ -n "$unmerged10" ]; then
  echo "FAIL[10]: gate left UNMERGED paths in the shared checkout:"; echo "$unmerged10"; echo "$out10"; fail=1
elif [ "$rc10" -eq 0 ] && [ -n "$(git -C "$C10" ls-files -u)" ]; then
  echo "FAIL[10]: exited 0 with a conflicted tree"; fail=1
elif grep -rqs '^<<<<<<< ' "$C10/other.txt"; then
  echo "FAIL[10]: conflict markers left in a tracked file"; fail=1
else
  echo "PASS[10]: gate never exits with unmerged paths or conflict markers in the shared checkout ($rc10)"
fi

# ── case 11 (BRO-3393 ship-check): a failed fetch must leave a refusal ──────
# snapshot. morning-digest.plist runs the digest with `;` even when this script
# fails, so a silent fetch-failure exit meant the digest saw "nobody refused"
# and dispatched real headless sessions against a checkout whose freshness had
# just proven unverifiable. Real occurrence: 2026-09-15 10:30, Xcode license
# failure broke git for every launchd job on this machine.
C11="$TMP/clone11"
git init -q -b main "$C11"
git -C "$C11" config user.email t@t.t
git -C "$C11" config user.name t
mkdir -p "$C11/data/audit"
echo hello > "$C11/other.txt"
git -C "$C11" add -A
git -C "$C11" commit -q -m init
git -C "$C11" remote add origin "$TMP/no-such-origin-at-all"
out11=$(SYNC_TAG=case11 bash "$LIB" "$C11" 2>&1); rc11=$?
snap11="$C11/data/audit/sync-refused-case11.json"
if [ "$rc11" -eq 0 ]; then
  echo "FAIL[11]: an unreachable origin must not exit 0. Output:"; echo "$out11"; fail=1
elif [ ! -f "$snap11" ]; then
  echo "FAIL[11]: a failed fetch must still write $snap11 — otherwise the digest reads 'nobody refused'. Output:"; echo "$out11"; fail=1
elif ! grep -q '"reason": "fetch-failed"' "$snap11"; then
  echo "FAIL[11]: expected reason=fetch-failed in $snap11, got:"; cat "$snap11"; fail=1
else
  echo "PASS[11]: a failed fetch writes a refusal snapshot instead of exiting silently ($rc11)"
fi

# ── case 12 (BRO-3393 ship-check P0): a merge left mid-flight self-heals ────
# The merge-origin recovery can be killed by a launchd timeout between
# `git merge` and `git merge --abort`, and its own abort can fail. Either way
# MERGE_HEAD survives. Without a self-heal the recovery's MERGE_HEAD guard
# REFUSES on every subsequent run — "refuses forever", the exact failure mode
# BRO-3212 wrote the rebase self-heal for, reintroduced through the merge path.
# It also breaks EVERY other session sharing the checkout, not just this job
# ("Committing is not possible because you have unmerged files").
O12="$TMP/origin12"; C12="$TMP/clone12"
setup_pair "$O12" "$C12"
advance_origin "$O12" "$TMP/via12"
# Leave a real conflicting merge mid-flight, exactly as a killed run would.
printf 'local side\n' > "$C12/other.txt"
git -C "$C12" commit -q -am "local edit to other.txt"
git -C "$C12" fetch -q origin main
git -C "$C12" merge --no-commit origin/main >/dev/null 2>&1
if ! git -C "$C12" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "FAIL[12]: test setup did not leave a MERGE_HEAD to heal"; fail=1
else
  out12=$(SYNC_TAG=case12 bash "$LIB" "$C12" 2>&1); rc12=$?
  if git -C "$C12" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "FAIL[12]: MERGE_HEAD survived the run — the checkout stays blocked for every session. Output:"; echo "$out12"; fail=1
  elif [ -n "$(git -C "$C12" ls-files -u)" ]; then
    echo "FAIL[12]: unmerged index entries survived the run"; fail=1
  elif ! echo "$out12" | grep -q "merge left mid-flight"; then
    echo "FAIL[12]: expected the self-heal to announce itself. Output:"; echo "$out12"; fail=1
  else
    echo "PASS[12]: a merge left mid-flight by an interrupted run is aborted and self-healed ($rc12)"
  fi
fi

# ── case 13 (BRO-4141 W1): never sync a checkout that is not on main ───────
# checkout-sync.plist runs this every 30 min unattended; fast-forwarding or
# rebasing a feature branch someone left checked out would rewrite their work.
O13="$TMP/origin13"; C13="$TMP/clone13"
setup_pair "$O13" "$C13"
git -C "$C13" checkout -q -b feature-x
echo local > "$C13/feature.txt"; git -C "$C13" add -A; git -C "$C13" commit -q -m feature
before13=$(git -C "$C13" rev-parse HEAD)
out13=$(SYNC_TAG=case13 bash "$LIB" "$C13" 2>&1); rc13=$?
if [ "$rc13" -eq 0 ]; then
  echo "FAIL[13]: syncing a non-main branch must refuse. Output:"; echo "$out13"; fail=1
elif [ "$(git -C "$C13" rev-parse HEAD)" != "$before13" ] || [ "$(git -C "$C13" symbolic-ref --short HEAD)" != "feature-x" ]; then
  echo "FAIL[13]: the feature branch was moved"; fail=1
elif ! grep -q '"reason": "not-on-main:feature-x"' "$C13/data/audit/sync-refused-case13.json" 2>/dev/null; then
  echo "FAIL[13]: expected a not-on-main refusal snapshot. Output:"; echo "$out13"; fail=1
else
  echo "PASS[13]: a non-main checkout is refused and left untouched ($rc13)"
fi

if [ "$fail" -ne 0 ]; then
  echo "sync-audit-checkout test: FAILED"; exit 1
fi
echo "sync-audit-checkout test: OK"
