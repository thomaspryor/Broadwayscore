#!/usr/bin/env bash
# Test for ensure_disk_floor() (task #968): push-with-retry.sh and
# merge-worktree-to-main.sh must self-heal a low-disk condition right before
# the git op that needs the space, instead of waiting on worktree-gc's cron.
# Run: bash scripts/lib/disk-floor-check.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

# BRO-2751: every case below except case 3 must exercise the NON-CI path.
# ensure_disk_floor() returns 0 immediately when GITHUB_ACTIONS is set
# (disk-floor-check.sh:17), and a GitHub runner exports GITHUB_ACTIONS=true
# ambiently — so on CI, cases 1 and 4 FAILED outright and cases 2 and 5 passed
# vacuously (the early return, never the logic they claim to cover). That is why
# this file could not simply be registered in test.yml as-is. Each subshell now
# clears the variable itself rather than the workflow step doing it, so the test
# is portable to any environment, not just one hand-patched CI step.
# Reproduce the old failure with: GITHUB_ACTIONS=true bash "$0"

# BRO-6592: same reasoning for NODE_TEST_CONTEXT (set when a node --test file
# drives this suite); case 9 covers that skip explicitly.
unset NODE_TEST_CONTEXT
# Cases 1-9 exercise the synchronous path (GC finished when ensure_disk_floor
# returns). Everything under 100GB counts as critical here; cases 10-11 reset it.
export DISK_PREFLIGHT_CRITICAL_GB=100

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKE_REPO="$TMP/repo"
mkdir -p "$FAKE_REPO/scripts/lib" "$FAKE_REPO/data/audit"
cp "$SCRIPT_DIR/disk-floor-check.sh" "$FAKE_REPO/scripts/lib/disk-floor-check.sh"

GC_MARKER="$TMP/gc-ran"
# BRO-6592 cooldown stamp. FAKE_REPO is not a git repo, so the stamp falls back
# to data/audit/. Cases that expect a GC clear it first.
STAMP="$FAKE_REPO/data/audit/disk-preflight-gc.stamp"
cat > "$FAKE_REPO/scripts/gc-merged-worktrees.sh" <<EOF
#!/usr/bin/env bash
sleep "\${FAKE_GC_SLEEP:-0}"
echo ran >> "$GC_MARKER"
EOF
chmod +x "$FAKE_REPO/scripts/gc-merged-worktrees.sh"

# Fake `df` on PATH so the test controls "free space" deterministically
# instead of depending on the real host's disk state.
fake_bin() {
  local free_kb="$1"
  local dir="$TMP/bin-$free_kb"
  mkdir -p "$dir"
  cat > "$dir/df" <<EOF
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/disk1 100 1 $free_kb 1% /"
EOF
  chmod +x "$dir/df"
  echo "$dir"
}

# Case 1: below floor (3GB free < 5GB default floor) → GC runs.
BINDIR=$(fake_bin $((3 * 1024 * 1024)))
rm -f "$GC_MARKER" "$STAMP"
( PATH="$BINDIR:$PATH"; unset GITHUB_ACTIONS; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "PASS[1]: below-floor free space triggers emergency GC"
else
  echo "FAIL[1]: below-floor free space did NOT trigger GC"; fail=1
fi

# Case 2: above floor (50GB free) → GC does not run.
BINDIR=$(fake_bin $((50 * 1024 * 1024)))
rm -f "$GC_MARKER"
( PATH="$BINDIR:$PATH"; unset GITHUB_ACTIONS; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "FAIL[2]: above-floor free space incorrectly triggered GC"; fail=1
else
  echo "PASS[2]: above-floor free space correctly skips GC"
fi

# Case 3: CI environment → always skips, even when below floor.
BINDIR=$(fake_bin $((3 * 1024 * 1024)))
rm -f "$GC_MARKER"
( PATH="$BINDIR:$PATH"; cd "$FAKE_REPO"; export GITHUB_ACTIONS=true; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "FAIL[3]: GITHUB_ACTIONS env did not skip the check"; fail=1
else
  echo "PASS[3]: GITHUB_ACTIONS env correctly skips the check"
fi

# Case 4: custom floor via DISK_PREFLIGHT_FLOOR_GB.
BINDIR=$(fake_bin $((8 * 1024 * 1024)))
rm -f "$GC_MARKER" "$STAMP"
( PATH="$BINDIR:$PATH"; unset GITHUB_ACTIONS; cd "$FAKE_REPO"; export DISK_PREFLIGHT_FLOOR_GB=10; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "PASS[4]: custom DISK_PREFLIGHT_FLOOR_GB=10 triggers GC at 8GB free"
else
  echo "FAIL[4]: custom floor override was not honored"; fail=1
fi

# NOTE: GC-run serialization (concurrent-session lock, stale-lock reclaim)
# used to be tested here, but the lock moved INTO gc-merged-worktrees.sh
# itself (task #968 follow-up, /what-else lens-2 finding: locking only at
# this call site missed the launchd cron's direct invocation of the same
# script). See scripts/gc-merged-worktrees.lock.test.sh for those cases.

# Case 5: `df` itself fails (nonzero exit) — under the caller's real-world
# `set -euo pipefail` (push-with-retry.sh, merge-worktree-to-main.sh), an
# unguarded `free_gb=$(df ... | awk ...)` assignment would trip errexit and
# silently kill the ENTIRE push/merge — the opposite of "fail-open"
# (adversarial review, task #968). Assert the caller survives past the call.
BROKEN_DF_DIR="$TMP/bin-broken-df"
mkdir -p "$BROKEN_DF_DIR"
cat > "$BROKEN_DF_DIR/df" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$BROKEN_DF_DIR/df"
rm -f "$GC_MARKER"
OUT=$( PATH="$BROKEN_DF_DIR:$PATH" bash -c '
  set -euo pipefail
  unset GITHUB_ACTIONS
  cd "'"$FAKE_REPO"'"
  source "scripts/lib/disk-floor-check.sh"
  ensure_disk_floor
  echo SURVIVED
' 2>&1 )
if grep -q "SURVIVED" <<<"$OUT"; then
  echo "PASS[5]: caller survives a failing df under set -euo pipefail (fail-open holds)"
else
  echo "FAIL[5]: caller was killed by a failing df under set -e — fail-open is broken. Output: $OUT"; fail=1
fi

# Case 6 (BRO-6592): a second below-floor call inside the cooldown must NOT
# re-run the GC. On the Mac Studio a full pass takes ~220s and frees 0KB when
# nothing is merged+clean; without the cooldown every push repeated it, and a
# 20s-deadline push-with-retry caller took 240s.
# run_low uses the real (non-critical, background) path, so callers wait for
# the GC with wait_runs before asserting.
wait_runs() {  # wait_runs <n> — up to 5s for GC_MARKER to reach n lines AND the stamp
  for _ in $(seq 1 50); do
    [ "$({ cat "$GC_MARKER" 2>/dev/null || true; } | wc -l | tr -d ' ')" -ge "$1" ] 2>/dev/null && [ -f "$STAMP" ] && sleep 0.2 && return 0
    sleep 0.1
  done
}
run_low() {  # run_low <cooldown|""> — one below-floor ensure_disk_floor call
  ( PATH="$(fake_bin $((3 * 1024 * 1024))):$PATH"; unset GITHUB_ACTIONS; export DISK_PREFLIGHT_CRITICAL_GB=1; cd "$FAKE_REPO"
    if [ -n "$1" ]; then export DISK_PREFLIGHT_GC_COOLDOWN_SEC="$1"; else unset DISK_PREFLIGHT_GC_COOLDOWN_SEC; fi
    source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) 2>&1
}
rm -f "$GC_MARKER" "$STAMP"
run_low "" >/dev/null; wait_runs 1
OUT6=$(run_low ""); sleep 0.5
runs=$({ cat "$GC_MARKER" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "${runs:-0}" = "1" ] && grep -q "cooldown" <<<"$OUT6"; then
  echo "PASS[6]: second below-floor call inside the cooldown skips the GC"
else
  echo "FAIL[6]: expected exactly 1 GC run and a cooldown notice, got runs=${runs:-0}. Output: $OUT6"; fail=1
fi

# Case 7: an expired stamp (older than the cooldown) runs the GC again.
rm -f "$GC_MARKER"
echo $(( $(date +%s) - 3600 )) > "$STAMP"
run_low "1800" >/dev/null; wait_runs 1
if [ -f "$GC_MARKER" ]; then
  echo "PASS[7]: stamp older than the cooldown lets the GC run again"
else
  echo "FAIL[7]: an expired cooldown stamp still suppressed the GC"; fail=1
fi

# Case 8: DISK_PREFLIGHT_GC_COOLDOWN_SEC=0 disables the cooldown; a corrupt
# stamp fails open (GC runs).
rm -f "$GC_MARKER"
run_low "0" >/dev/null; wait_runs 1
echo garbage > "$STAMP"
run_low "" >/dev/null; wait_runs 2
runs=$({ cat "$GC_MARKER" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "${runs:-0}" = "2" ]; then
  echo "PASS[8]: cooldown 0 always runs, corrupt stamp fails open"
else
  echo "FAIL[8]: expected 2 GC runs (cooldown=0, then corrupt stamp), got ${runs:-0}"; fail=1
fi

# Case 9 (BRO-6592): inside a node --test process the preflight is skipped, so
# a test driving push-with-retry.sh never runs the real host's worktree GC.
rm -f "$GC_MARKER" "$STAMP"
( PATH="$(fake_bin $((3 * 1024 * 1024))):$PATH"; unset GITHUB_ACTIONS; export NODE_TEST_CONTEXT=child-v8; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "FAIL[9]: NODE_TEST_CONTEXT did not skip the preflight GC"; fail=1
else
  echo "PASS[9]: NODE_TEST_CONTEXT (node --test child) skips the preflight GC"
fi

# Case 10 (BRO-6592): above the critical threshold the GC runs in the
# background. A slow (4s) GC must not hold up the caller, even when the
# caller's output is captured with $(...), the shape that ran 240s before.
rm -f "$GC_MARKER" "$STAMP"
s10=$SECONDS
OUT10=$( PATH="$(fake_bin $((3 * 1024 * 1024))):$PATH"; unset GITHUB_ACTIONS; export DISK_PREFLIGHT_CRITICAL_GB=1 FAKE_GC_SLEEP=4; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor 2>&1 )
e10=$(( SECONDS - s10 ))
early=$([ -f "$GC_MARKER" ] && echo yes || echo no)
for _ in $(seq 1 30); do [ -f "$STAMP" ] && break; sleep 0.5; done
if [ "$e10" -le 2 ] && [ "$early" = no ] && [ -f "$GC_MARKER" ] && [ -f "$STAMP" ] && grep -q "background" <<<"$OUT10"; then
  echo "PASS[10]: non-critical GC runs in the background (caller returned in ${e10}s, GC + stamp landed after)"
else
  echo "FAIL[10]: elapsed=${e10}s early_marker=$early marker=$([ -f "$GC_MARKER" ] && echo y) stamp=$([ -f "$STAMP" ] && echo y). Output: $OUT10"; fail=1
fi

# Case 11: below the critical threshold the cooldown is ignored (the task #968
# "117MB free" case must always get a synchronous GC).
rm -f "$GC_MARKER"; date +%s > "$STAMP"
( PATH="$(fake_bin $((200 * 1024))):$PATH"; unset GITHUB_ACTIONS; export DISK_PREFLIGHT_CRITICAL_GB=1; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "PASS[11]: critical free space runs the GC synchronously despite a fresh cooldown stamp"
else
  echo "FAIL[11]: a fresh stamp suppressed the GC at 0GB free"; fail=1
fi

# Case 12: a leading-zero stamp ("08") and cooldown ("0900") must not be read
# as octal and kill a set -euo pipefail caller (review finding, BRO-6592).
echo 08 > "$STAMP"
OUT12=$( PATH="$(fake_bin $((3 * 1024 * 1024))):$PATH" bash -c '
  set -euo pipefail; unset GITHUB_ACTIONS; export DISK_PREFLIGHT_GC_COOLDOWN_SEC=0900
  cd "'"$FAKE_REPO"'"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor; echo SURVIVED' 2>&1 )
if grep -q SURVIVED <<<"$OUT12"; then
  echo "PASS[12]: leading-zero stamp/cooldown does not abort a set -e caller"
else
  echo "FAIL[12]: caller died on a leading-zero stamp. Output: $OUT12"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "disk-floor-check test: FAILED"; exit 1
fi
echo "disk-floor-check test: OK"
