#!/usr/bin/env bash
# Integration test for the overall-deadline hang guard in push-with-retry.sh
# (task #183 / Notion 39d637c5). Under high commit churn a stalled git fetch/push
# could leave the retry loop running for 20-25+ min; the deadline breaks the loop
# so the job always reaches a conclusion. This test sets up a throwaway repo with
# NO reachable remote (so every push attempt fails) and asserts the script:
#   1. honours PUSH_DEADLINE_SEC and stops instead of exhausting all retries, and
#   2. never approaches the old multi-minute hang — it returns fast, exit 1, with
#      the deadline ::warning:: on stderr/stdout.
# Run: bash scripts/lib/push-with-retry.deadline.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

setup_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
}

# --- Case 1: deadline=0 → break before any attempt, exit 1, warning present ---
TMP1=$(mktemp -d)
trap 'rm -rf "$TMP1" "${TMP2:-}" "${TMP3:-}"' EXIT
setup_repo "$TMP1"
# A staged (clean) change so there is real work queued; no remote is configured,
# so a push WOULD fail — but deadline=0 must short-circuit before that.
printf '{ "ok": 1 }\n' > "$TMP1/state.json"
git -C "$TMP1" add state.json
out=$( cd "$TMP1" && PUSH_DEADLINE_SEC=0 bash "$PUSH_SCRIPT" 50 main 2>&1 ); code=$?
if [ "$code" -ne 1 ]; then
  echo "FAIL[1]: expected exit 1 when deadline exceeded, got $code"; fail=1
elif ! grep -q "overall deadline .* exceeded" <<<"$out"; then
  echo "FAIL[1]: exit 1 but missing deadline warning. Output:"; echo "$out"; fail=1
else
  echo "PASS[1]: deadline=0 short-circuits the retry loop (exit 1 + warning)"
fi

# --- Case 2: small deadline + many retries → returns FAST, does not hang ---
# The old bug let this run for many minutes. With a 2s budget it must finish well
# under a minute even though MAX_RETRIES=50 and every push fails on the bogus remote.
TMP2=$(mktemp -d)
setup_repo "$TMP2"
git -C "$TMP2" remote add origin "file:///nonexistent/definitely/not/a/repo.git"
printf '{ "ok": 2 }\n' > "$TMP2/state.json"
git -C "$TMP2" add state.json
start=$SECONDS
out2=$( cd "$TMP2" && PUSH_DEADLINE_SEC=2 bash "$PUSH_SCRIPT" 50 main 2>&1 ); code2=$?
elapsed=$(( SECONDS - start ))
if [ "$elapsed" -ge 60 ]; then
  echo "FAIL[2]: took ${elapsed}s (>=60s) — deadline did not bound the loop"; fail=1
elif [ "$code2" -ne 1 ]; then
  echo "FAIL[2]: expected exit 1 after deadline, got $code2 (elapsed ${elapsed}s)"; fail=1
elif ! grep -q "overall deadline .* exceeded" <<<"$out2"; then
  echo "FAIL[2]: no deadline warning. Output:"; echo "$out2"; fail=1
else
  echo "PASS[2]: bounded to ${elapsed}s under 50 failing retries (exit 1 + warning)"
fi

# --- Case 3: a genuinely HUNG push is killed by the per-op timeout, not waited out.
# Uses git's ext:: transport to run a 120s sleep AS the push transport (the exact
# stall class from the incident: an open-but-idle connection). With GIT_NET_TIMEOUT_SEC=2
# the _timeout wrapper must SIGKILL it in ~2s so the whole run finishes fast. Requires
# a `timeout`/`gtimeout` binary (the wrapper fails OPEN without one — documented), so
# SKIP on hosts lacking it (stock macOS) rather than hang the suite for 120s. ---
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  TMP3=$(mktemp -d)
  setup_repo "$TMP3"
  git -C "$TMP3" config protocol.ext.allow always   # ext:: is user-gated by default
  git -C "$TMP3" remote add origin "ext::sh -c 'sleep 120'"
  printf '{ "ok": 3 }\n' > "$TMP3/state.json"
  git -C "$TMP3" add state.json
  start=$SECONDS
  out3=$( cd "$TMP3" && GIT_NET_TIMEOUT_SEC=2 PUSH_DEADLINE_SEC=6 bash "$PUSH_SCRIPT" 3 main 2>&1 ); code3=$?
  elapsed=$(( SECONDS - start ))
  # 3 attempts × (2s timeout kill + short backoff), bounded by the 6s deadline: must be
  # well under the 120s a single un-killed sleep would take. Generous 40s ceiling for CI.
  if [ "$elapsed" -ge 40 ]; then
    echo "FAIL[3]: took ${elapsed}s — hung push was NOT killed by the per-op timeout"; fail=1
  elif [ "$code3" -eq 0 ]; then
    echo "FAIL[3]: push unexpectedly succeeded against a sleeping transport (code $code3)"; fail=1
  else
    echo "PASS[3]: hung push killed in ${elapsed}s (per-op timeout works; exit $code3)"
  fi
else
  echo "SKIP[3]: no timeout/gtimeout binary — per-op hard kill unavailable here (fail-open by design)"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry deadline guard test: FAILED"; exit 1
fi
echo "push-with-retry deadline guard test: OK"
