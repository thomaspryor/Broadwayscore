#!/usr/bin/env bash
# Test for ensure_disk_floor() (task #968): push-with-retry.sh and
# merge-worktree-to-main.sh must self-heal a low-disk condition right before
# the git op that needs the space, instead of waiting on worktree-gc's cron.
# Run: bash scripts/lib/disk-floor-check.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKE_REPO="$TMP/repo"
mkdir -p "$FAKE_REPO/scripts/lib" "$FAKE_REPO/data/audit"
cp "$SCRIPT_DIR/disk-floor-check.sh" "$FAKE_REPO/scripts/lib/disk-floor-check.sh"

GC_MARKER="$TMP/gc-ran"
cat > "$FAKE_REPO/scripts/gc-merged-worktrees.sh" <<EOF
#!/usr/bin/env bash
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
rm -f "$GC_MARKER"
( PATH="$BINDIR:$PATH"; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
if [ -f "$GC_MARKER" ]; then
  echo "PASS[1]: below-floor free space triggers emergency GC"
else
  echo "FAIL[1]: below-floor free space did NOT trigger GC"; fail=1
fi

# Case 2: above floor (50GB free) → GC does not run.
BINDIR=$(fake_bin $((50 * 1024 * 1024)))
rm -f "$GC_MARKER"
( PATH="$BINDIR:$PATH"; cd "$FAKE_REPO"; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
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
rm -f "$GC_MARKER"
( PATH="$BINDIR:$PATH"; cd "$FAKE_REPO"; export DISK_PREFLIGHT_FLOOR_GB=10; source "scripts/lib/disk-floor-check.sh"; ensure_disk_floor ) >/dev/null 2>&1
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

if [ "$fail" -ne 0 ]; then
  echo "disk-floor-check test: FAILED"; exit 1
fi
echo "disk-floor-check test: OK"
