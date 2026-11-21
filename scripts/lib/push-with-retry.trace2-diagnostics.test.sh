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
# BRO-2664: no case may append to the real data/audit/push-retry-failures.jsonl
# (push-with-retry.sh logs failures there in CI). The script only appends
# (>>), so /dev/null is safe; cases that read the log set their own path.
export PUSH_FAILURE_LOG="${PUSH_FAILURE_LOG:-/dev/null}"
# BRO-6592: keep the host disk preflight (a ~220s worktree GC when the Mac is
# under 5GB free) out of timing-sensitive cases.
export DISK_PREFLIGHT_FLOOR_GB=0

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
cleanup() { [ -n "${STALL_PID:-}" ] && kill "$STALL_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo one > f.txt && git add f.txt && git commit -qm one && git push -q origin HEAD:main
) >/dev/null 2>&1 || { echo "fixture setup failed"; exit 1; }

# A local HTTP endpoint that accepts the connection and never answers, so the
# push really hangs until GIT_NET_TIMEOUT_SEC kills it (rc=124) and the timeout
# diagnostics run. An unroutable address is not enough: behind an egress proxy
# (cloud sandboxes) it is refused in 0s with rc=128 and every timeout-path case
# below would pass without the path ever running.
node -e '
  const srv = require("net").createServer(() => {}).listen(0, "127.0.0.1", () => {
    require("fs").writeFileSync(process.argv[1], String(srv.address().port));
  });
' "$WORK/stall.port" &
STALL_PID=$!
for _ in $(seq 1 50); do [ -s "$WORK/stall.port" ] && break; sleep 0.1; done
STALL_PORT=$(cat "$WORK/stall.port" 2>/dev/null || true)
[ -n "$STALL_PORT" ] || { echo "stalling server failed to start"; exit 1; }

run_killed_push() {  # run_killed_push <log-file> <extra-env...>
  local log="$1"; shift
  (
    cd "$WORK/repo" || exit 1
    git config user.email t@t.t && git config user.name t
    echo "$RANDOM" > h.txt && git add h.txt && git commit -qm local
    git remote set-url --push origin "http://x-access-token:FAKE_TRACE2_TOKEN_XYZ@127.0.0.1:$STALL_PORT/blackhole.git"
    env "$@" NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 PUSH_SKIP_FAILURE_LEDGER=1 MAX_RETRIES=1 GIT_NET_TIMEOUT_SEC=3 \
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
LEDGER_ON="$WORK/on-failures.jsonl"
run_killed_push "$LOG_ON" PUSH_TRACE2_DIAGNOSTICS=1 PUSH_FAILURE_LOG="$LEDGER_ON"
if ! grep -q "git-transport stall phase" "$LOG_ON"; then
  fail 0 "the push was not killed mid-transport, so the timeout diagnostics never ran and cases 3/4/6 would prove nothing"
  sed 's/^/    /' "$LOG_ON" | head -20
fi
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
# BRO-3465: the killed attempt's census + trace2 summary must reach the failure
# ledger row (not only CI stdout), as ONE valid JSON line with no credential.
# Every row is parsed: the hand-rolled printf is the thing under test, and
# health-check's readJsonlLedgerOrNull silently drops a malformed line.
if [ ! -s "$LEDGER_ON" ]; then
  fail 6 "no failure-ledger row written for the killed push"
elif ! node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const r = rows[rows.length - 1];
  const bad = [];
  if (!/receive-pack=\d+ upload-pack=\d+/.test(r.traceCensus || "")) bad.push("traceCensus missing/unshaped: " + r.traceCensus);
  if (!r.trace2Summary) bad.push("trace2Summary missing");
  for (const k of ["traceCensus", "trace2Summary"]) {
    if (/[\u0000-\u001f]/.test(r[k] || "")) bad.push(k + " has a control character");
  }
  if ((r.traceCensus || "").length > 300 || (r.trace2Summary || "").length > 500) bad.push("cap exceeded");
  if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
' "$LEDGER_ON"; then
  fail 6 "failure-ledger row is not valid JSON or lacks the trace diagnostics"; cat "$LEDGER_ON"
elif grep -q "FAKE_TRACE2_TOKEN_XYZ" "$LEDGER_ON"; then
  fail 6 "embedded credential leaked into the failure-ledger row"
else
  pass 6 "killed push: ledger row is valid JSON with traceCensus + trace2Summary, no credential"
fi

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
