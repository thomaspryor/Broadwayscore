#!/usr/bin/env bash
# BRO-7113 cousin: a wall-clock bound for one `node --test` / `npx tsx --test` batch.
#
# --test-timeout bounds each TEST, not a test-file child process that never exits,
# and the runner reports files in list order, so one wedged child silently holds
# the whole batch. 2026-11-10..15: the E2E Tests unit batch (normally ~90 s)
# stalled 4 times until the 55-min job limit, concluded `cancelled` with no file
# named, and was counted as a hung red run by ci-green-rate.
#
# This runs the command in its own process group, and if it is still running after
# <seconds> it prints the test files whose child processes are still alive (the
# stalled ones), kills the group and exits 124 with an ::error:: naming them. A run
# that finishes in time passes its exit code through unchanged. Output is tee'd to
# <logfile> so summarize-failing-tests.sh can still name failing tests.
#
# Usage: run-test-batch-bounded.sh <label> <seconds> <logfile> -- <command...>
# Guard: scripts/lib/run-test-batch-bounded.test.mjs
set -u
label="$1"; secs="$2"; log="$3"; shift 3
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "::error::run-test-batch-bounded.sh: no command given"; exit 2; }
case "$secs" in ''|*[!0-9]*) echo "::error::run-test-batch-bounded.sh: seconds must be a positive integer, got '$secs'"; exit 2;; esac

# set -m: a background job gets its own process group (pgid == $!), so the kill
# reaches every test child. Portable (macOS has no setsid).
# The tee runs INSIDE the backgrounded subshell (pipefail keeps the command's exit
# code), so `wait` returns only after the log is fully written and callers that
# parse it (summarize-failing-tests.sh, run_batch counts) never read a partial log.
set -m
( set -o pipefail; "$@" 2>&1 | tee "$log" ) &
pid=$!
deadline=$(( $(date +%s) + secs ))
while kill -0 "$pid" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    # The runner spawns one child per test file with that ONE path in argv; the
    # runner and npx/tsx wrappers carry the whole list, so keep single-file lines.
    stalled=$(ps -ww -A -o pgid=,args= 2>/dev/null | awk -v g="$pid" '$1 == g' \
      | awk '{ n = 0; f = ""; for (i = 2; i <= NF; i++) if ($i ~ /\.test\.(mjs|cjs|js|ts|mts)$/) { n++; f = $i } if (n == 1) print f }' \
      | sort -u | tr '\n' ' ')
    kill -TERM -- "-$pid" 2>/dev/null; sleep 5; kill -KILL -- "-$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    msg="$label batch still running after ${secs}s (normal runtime is a small fraction of that), killed."
    if [ -n "$stalled" ]; then msg="$msg Test files still running: ${stalled% }"; else msg="$msg No test-file child was alive, so the runner itself stalled."; fi
    echo "::error title=Stalled test batch::$msg"
    # TAP-shaped lines so the existing triage parsers (summarize-failing-tests.sh,
    # main-red-streak.js firstFailingTestFileInJobLog) name the stalled file too.
    n=0
    for f in $stalled; do
      n=$((n + 1))
      printf 'not ok %d - %s (stalled: still running after %ss, killed)\n  ---\n  location: '"'"'%s:1:1'"'"'\n  ...\n' "$n" "$f" "$secs" "$f" | tee -a "$log"
    done
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '### %s batch stalled\n%s\n' "$label" "$msg" >> "$GITHUB_STEP_SUMMARY"
    exit 124
  fi
  sleep 2
done
wait "$pid"
