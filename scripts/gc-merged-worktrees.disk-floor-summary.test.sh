#!/usr/bin/env bash
# Regression test for task #968: check_disk_floor()/clean_derived_data()/
# clean_stale_scratchpad() used to return their freed-KB count via
# `echo "$n"` inside a function that ALSO calls log() (which itself prints
# to stdout via `tee`). Capturing that with `x=$(fn)` swept the log lines
# into the numeric var, so `$((floor_freed_kb + strip_freed_kb))` blew up
# with "syntax error: operand expected" followed by "total_freed_kb: unbound
# variable" — the GC's own DONE summary crashed before it could report freed
# space, exactly the symptom task #968's acceptance criteria calls out
# ("confirm it reports freed space"). Live-fired via `launchctl kickstart`
# on 2026-08-03 (disk sat at 15GB free, below the 20GB floor) and reproduced
# every time. Fixed by switching to global-variable returns (matching the
# pre-existing LAST_STRIP_FREED_KB pattern already used elsewhere in this
# file). Run: bash scripts/gc-merged-worktrees.disk-floor-summary.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/gc-merged-worktrees.sh"
# Run against a private lock (BRO-2607 seam), not the production one. Without
# this the test both (a) contends with a live launchd/cron GC and with its own
# earlier invocations — observed 2026-08-31 as FAIL[3]/FAIL[4] whose only
# output was "SKIP-RUN — another invocation already in progress", which reads
# as a real failure and is not — and (b) can leave the production lock in a
# state a real GC then trips over.
GC_TEST_LOCK_BASE="$(mktemp -d "${TMPDIR:-/tmp}/gc-df-test-XXXXXX")"
export WORKTREE_GC_LOCK_DIR="$GC_TEST_LOCK_BASE/lock"
trap 'rm -rf "$GC_TEST_LOCK_BASE"' EXIT
fail=0

# Force the disk-floor path to trigger regardless of this machine's actual
# free space, using --dry-run so nothing is deleted.
out=$(WORKTREE_GC_DISK_FLOOR_GB=999999 bash "$SCRIPT" --dry-run 2>&1)

if grep -qi "unbound variable" <<<"$out"; then
  echo "FAIL[1]: 'unbound variable' crash reproduced. Output tail:"; tail -5 <<<"$out"; fail=1
else
  echo "PASS[1]: no 'unbound variable' crash"
fi

if grep -qi "syntax error" <<<"$out"; then
  echo "FAIL[2]: arithmetic syntax error reproduced (log() output leaked into a numeric var). Output tail:"; tail -5 <<<"$out"; fail=1
else
  echo "PASS[2]: no arithmetic syntax error"
fi

if grep -qi "ALERT: disk free" <<<"$out"; then
  echo "PASS[3]: forced-low floor actually triggered the emergency-cleanup path"
else
  echo "FAIL[3]: disk-floor ALERT never fired — test didn't exercise the code path. Output tail:"; tail -5 <<<"$out"; fail=1
fi

# The final summary line must carry a real freed= value (e.g. "freed=0KB" or
# "freed=1.2MB"), not "freed=" (empty) or a truncated/missing DONE line.
if grep -qE '^\[.*\] DONE  removed=[0-9]+ kept=[0-9]+ skipped=[0-9]+ freed=[0-9]' <<<"$out"; then
  echo "PASS[4]: DONE summary line reports a numeric freed= value"
else
  echo "FAIL[4]: DONE line missing or freed= empty/non-numeric. Output tail:"; tail -5 <<<"$out"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "gc-merged-worktrees disk-floor-summary test: FAILED"; exit 1
fi
echo "gc-merged-worktrees disk-floor-summary test: OK"
