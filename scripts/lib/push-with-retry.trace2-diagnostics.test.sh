#!/usr/bin/env bash
# BRO-3358: PUSH_TRACE2_DIAGNOSTICS adds a SECOND temp file (trace2_file)
# alongside the existing curl trace_file inside git_push_traced()'s RETURN
# trap. That trap unconditionally expands "$trace2_file" on EVERY call, even
# when the flag is off — under this file's `set -euo pipefail`, an undeclared
# local would be an unbound-variable error on every single push in all ~157
# call sites, not just the ones that opt in. The existing
# push-with-retry.stall-diagnostics.test.sh only exercises the ORIGINAL
# curl-trace path and would not catch a regression here; this test invokes
# the REAL script (not a mock) with the flag both off and on, against both a
# killed push and a normal one, to pin down exactly the class of bug caught
# in this card's pre-implementation review.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/push-with-retry.sh"
fails=0
pass() { echo "PASS[$1]: $2"; }
fail() { echo "FAIL[$1]: $2"; fails=$((fails + 1)); }

if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
  echo "SKIP[1,2,3,4]: no timeout/gtimeout binary — _timeout fails open, so a push cannot be killed mid-transport here"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP[1,2,3,4]: no node binary — the diagnostics CLI (push-diagnostics-cli.js) cannot run"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/push-trace2-diag.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo one > f.txt && git add f.txt && git commit -qm one && git push -q origin HEAD:main
) >/dev/null 2>&1 || { echo "fixture setup failed"; exit 1; }

run_killed_push() {  # run_killed_push <log-file> <extra-env...>
  local log="$1"; shift
  (
    cd "$WORK/repo" || exit 1
    git config user.email t@t.t && git config user.name t
    echo "$RANDOM" > h.txt && git add h.txt && git commit -qm local
    git remote set-url --push origin "https://x-access-token:FAKE_TRACE2_TOKEN_XYZ@10.255.255.1/blackhole.git"
    env "$@" PUSH_SKIP_FAILURE_LEDGER=1 MAX_RETRIES=1 GIT_NET_TIMEOUT_SEC=3 \
      PUSH_API_FALLBACK_DISABLE=1 bash "$TARGET" 1 main
  ) > "$log" 2>&1
}

# 1. Flag OFF (default, ~157 call sites): a killed push must complete WITHOUT
#    an unbound-variable crash — the exact bug class this test exists to catch.
LOG_OFF="$WORK/off.log"
run_killed_push "$LOG_OFF"
if grep -qi "unbound variable" "$LOG_OFF"; then
  fail 1 "PUSH_TRACE2_DIAGNOSTICS unset crashed with an unbound-variable error — this would break every one of the ~157 default call sites"
  cat "$LOG_OFF"
else
  pass 1 "PUSH_TRACE2_DIAGNOSTICS unset: no unbound-variable crash"
fi

# 2. Flag OFF: no trace2 diagnostic output should appear at all — confirms
#    "default off" is actually off, not just "off unless something forces it on".
if grep -q "trace2:" "$LOG_OFF"; then
  fail 2 "trace2 diagnostics printed even though PUSH_TRACE2_DIAGNOSTICS was never set"
else
  pass 2 "PUSH_TRACE2_DIAGNOSTICS unset: no trace2 output (confirms default-off)"
fi

# 3. Flag ON: a killed push must complete without crashing, same as case 1 —
#    this is the actual new code path, not just the trap-declaration fix.
LOG_ON="$WORK/on.log"
run_killed_push "$LOG_ON" PUSH_TRACE2_DIAGNOSTICS=1
if grep -qi "unbound variable" "$LOG_ON"; then
  fail 3 "PUSH_TRACE2_DIAGNOSTICS=1 crashed with an unbound-variable error"
  cat "$LOG_ON"
else
  pass 3 "PUSH_TRACE2_DIAGNOSTICS=1: no unbound-variable crash"
fi

# 4. The embedded fake credential must never leak, in EITHER trace's echoed
#    output, mirroring push-with-retry.stall-diagnostics.test.sh's assertion 3
#    but specifically against the NEW trace2-raw/trace2 output lines.
if grep -q "FAKE_TRACE2_TOKEN_XYZ" "$LOG_ON"; then
  fail 4 "embedded credential leaked into the log via trace2 output"
else
  pass 4 "no credential leakage in trace2 output"
fi

# 5. A SUCCESSFUL (non-timeout) push with the flag ON must also complete
#    cleanly — the RETURN trap runs on every exit, not just the timeout branch.
LOG_SUCCESS="$WORK/success.log"
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  # Undo the blackhole push URL the killed-push cases above left in place on
  # this same clone — without this reset, "success" here would actually hang
  # the full GIT_NET_TIMEOUT_SEC trying to push nowhere (caught the hard way
  # while writing this test).
  git remote set-url --push origin "$WORK/origin.git"
  echo "$RANDOM" > s.txt && git add s.txt && git commit -qm local-success
  PUSH_TRACE2_DIAGNOSTICS=1 PUSH_SKIP_FAILURE_LEDGER=1 MAX_RETRIES=1 \
    timeout 20 bash "$TARGET" 1 main
) > "$LOG_SUCCESS" 2>&1
success_rc=$?
if [ "$success_rc" -eq 0 ] && ! grep -qi "unbound variable" "$LOG_SUCCESS"; then
  pass 5 "PUSH_TRACE2_DIAGNOSTICS=1: a successful push completes cleanly (rc=0, no crash)"
else
  fail 5 "PUSH_TRACE2_DIAGNOSTICS=1: successful push did not complete cleanly (rc=$success_rc)"
  cat "$LOG_SUCCESS"
fi

if [ "$fails" -eq 0 ]; then
  echo "=== push-with-retry.trace2-diagnostics.test.sh PASSED ==="
  exit 0
fi
echo "=== push-with-retry.trace2-diagnostics.test.sh FAILED ($fails) ==="
exit 1
