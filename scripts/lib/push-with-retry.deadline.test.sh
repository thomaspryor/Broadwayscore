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
trap 'rm -rf "$TMP1" "${TMP2:-}" "${TMP3:-}" "${TMP4:-}" "${TMP5:-}" "${TMP6:-}"' EXIT
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

# ─────────────────────────────────────────────────────────────────────────────
# Cases 4-6 (BRO-2839): the loop has THREE exits and only one is real
# exhaustion. Before this, all four POST-loop record_push_failure sites
# hardcoded "$MAX_RETRIES" as the attempt count and the generic one hardcoded
# the reason "retries-exhausted", so a deadline abort after N real attempts was
# durably indistinguishable from a full exhaustion. Measured on the
# authoritative ledger (origin/push-retry-failures:failures.jsonl, 2,264 rows
# on 2026-09-06): all 2,156 retries-exhausted rows carried attempt exactly
# equal to some caller's MAX_RETRIES and NOT ONE carried a mid-loop count.
#
# These assert on PUSH_FAILURE_LOG (the local JSONL, env-overridable, appended
# by every record_push_failure call) with PUSH_SKIP_FAILURE_LEDGER=1 so the
# durable CAS write to the push-retry-failures branch is never attempted.
# The LAST row is the post-loop one; earlier rows are in-loop sites that
# already recorded "$i" correctly and are not what regressed.
last_row() { tail -1 "$1" 2>/dev/null; }
row_field() { # row_field <file> <key>  — value of a top-level JSON scalar
  last_row "$1" | sed -E "s/.*\"$2\":\"?([^\",}]*)\"?.*/\1/"
}

# --- Case 4: DEADLINE exit → reason carries the (deadline) qualifier and the
# attempt count is the REAL completed count, not MAX_RETRIES. PUSH_DEADLINE_SEC=0
# breaks at i=1 before any attempt runs, so the true count is 0. ---
TMP4=$(mktemp -d); LOG4="$TMP4/failures.jsonl"
setup_repo "$TMP4"
printf '{ "ok": 4 }\n' > "$TMP4/state.json"
git -C "$TMP4" add state.json
( cd "$TMP4" && PUSH_DEADLINE_SEC=0 PUSH_SKIP_FAILURE_LEDGER=1 PUSH_FAILURE_LOG="$LOG4" \
    bash "$PUSH_SCRIPT" 9 main >/dev/null 2>&1 )
r4_reason=$(row_field "$LOG4" reason); r4_attempt=$(row_field "$LOG4" attempt)
if [ ! -s "$LOG4" ]; then
  echo "FAIL[4]: no failure row written to PUSH_FAILURE_LOG at all"; fail=1
elif [ "$r4_reason" != "retries-exhausted(deadline)" ]; then
  echo "FAIL[4]: expected reason retries-exhausted(deadline), got '$r4_reason'"; fail=1
elif [ "$r4_attempt" = "9" ]; then
  echo "FAIL[4]: attempt recorded as MAX_RETRIES (9) — the misattribution is back"; fail=1
elif [ "$r4_attempt" != "0" ]; then
  echo "FAIL[4]: expected attempt 0 (deadline broke before attempt 1), got '$r4_attempt'"; fail=1
else
  echo "PASS[4]: deadline exit files retries-exhausted(deadline) attempt=0, not 9"
fi

# --- Case 5: SERIES CONTINUITY. A genuine exhaustion must still file the
# historical reason verbatim ("retries-exhausted", no qualifier) with
# attempt == MAX_RETRIES, or the 2,156-row series in the ledger is broken and
# push-retry-deadman.js's counts change meaning. Fallback disabled and
# MAX_RETRIES=2 (below the PUSH_API_FALLBACK_AFTER_ATTEMPTS floor of 3) so
# neither early exit can fire; generous deadline so the deadline cannot fire. ---
TMP5=$(mktemp -d); LOG5="$TMP5/failures.jsonl"
setup_repo "$TMP5"
git -C "$TMP5" remote add origin "file:///nonexistent/definitely/not/a/repo.git"
printf '{ "ok": 5 }\n' > "$TMP5/state.json"
git -C "$TMP5" add state.json
out5=$( cd "$TMP5" && PUSH_DEADLINE_SEC=600 PUSH_API_FALLBACK_DISABLE=1 \
    PUSH_SKIP_FAILURE_LEDGER=1 PUSH_FAILURE_LOG="$LOG5" \
    bash "$PUSH_SCRIPT" 2 main 2>&1 )
r5_reason=$(row_field "$LOG5" reason); r5_attempt=$(row_field "$LOG5" attempt)
# Assert the loop really exited by EXHAUSTION. Without this the case could pass
# on a row produced by a different exit entirely and still look like proof that
# the historical reason survives.
if grep -qE "overall deadline .* exceeded|breaking out of the local" <<<"$out5"; then
  echo "FAIL[5]: an EARLY exit fired — this case must exercise true exhaustion"; fail=1
elif [ ! -s "$LOG5" ]; then
  echo "FAIL[5]: no failure row written for a genuine exhaustion"; fail=1
elif [ "$r5_reason" != "retries-exhausted" ]; then
  echo "FAIL[5]: true exhaustion must stay 'retries-exhausted' verbatim, got '$r5_reason'"; fail=1
elif [ "$r5_attempt" != "2" ]; then
  echo "FAIL[5]: expected attempt 2 (== MAX_RETRIES) on true exhaustion, got '$r5_attempt'"; fail=1
else
  echo "PASS[5]: true exhaustion unchanged — retries-exhausted attempt=2 (series intact)"
fi

# --- Case 6: EARLY-FALLBACK exit. This is the reviewer's correctness blocker:
# _FAILURE_TELEMETRY_SENT is first-write-wins, so for a fallback-ELIGIBLE caller
# the api-fallback-* row is the one that reaches the durable ledger, and fixing
# only the generic site would leave those callers uncorrected.
#
# Eligibility needs a resolvable origin merge-base (SCRIPT_ENTRY_BASE), so the
# remote must be SEEDED FIRST and only then made to reject. Install the
# pre-receive hook before the seed push and origin/main never exists, no merge
# base resolves, the fallback is never eligible, the early break never fires,
# and attempt==MAX_RETRIES is then CORRECT rather than the bug.
#
# THE SETUP IS ASSERTED, NOT ASSUMED. An earlier draft of this case treated a
# missing early-fallback warning as a passing SKIP, which meant any sandbox that
# disallows file:// pushes would silently delete the ONLY coverage of the
# early-fallback half of the fix while the suite stayed green. So the seed push
# and the merge-base are checked explicitly: if they worked, the warning MUST
# appear and its absence is a FAILURE. Only a demonstrably incapable
# environment (seed push refused) skips, and it says so. ---
TMP6=$(mktemp -d); LOG6="$TMP6/failures.jsonl"
BARE6="$TMP6/origin.git"; WORK6="$TMP6/work"
git init -q --bare "$BARE6"
git init -q "$WORK6"
git -C "$WORK6" config user.email t@t.t
git -C "$WORK6" config user.name t
git -C "$WORK6" commit -q --allow-empty -m init
git -C "$WORK6" branch -M main
git -C "$WORK6" remote add origin "file://$BARE6"
seed6_ok=true
git -C "$WORK6" push -q origin main 2>/dev/null || seed6_ok=false
git -C "$WORK6" fetch -q origin main:refs/remotes/origin/main 2>/dev/null || seed6_ok=false
base6=$(git -C "$WORK6" merge-base HEAD origin/main 2>/dev/null || true)
[ -n "$base6" ] || seed6_ok=false
printf '#!/bin/sh\nexit 1\n' > "$BARE6/hooks/pre-receive"   # now reject everything
chmod +x "$BARE6/hooks/pre-receive"
printf '{ "ok": 6 }\n' > "$WORK6/state.json"
git -C "$WORK6" add state.json
# COMMIT, do not merely stage. Cases 1-2-5 push at a remote that does not exist,
# so their pushes fail whatever the tree holds; this case's remote is real and
# only its pre-receive hook rejects, so a staged-but-uncommitted change leaves
# nothing ahead of origin/main and the script correctly reports "Everything
# up-to-date / Push succeeded on attempt 1" without entering the retry loop.
git -C "$WORK6" commit -q -m "state 6"
out6=$( cd "$WORK6" && PUSH_DEADLINE_SEC=45 PUSH_API_FALLBACK_AFTER_ATTEMPTS=1 \
    PUSH_SKIP_FAILURE_LEDGER=1 PUSH_FAILURE_LOG="$LOG6" \
    bash "$PUSH_SCRIPT" 9 main 2>&1 )
r6_attempt=$(row_field "$LOG6" attempt); r6_reason=$(row_field "$LOG6" reason)
# EVERY post-loop row, not just the last: a regression at one of the three
# api-fallback-* sites would be invisible to a last-row-only assertion, and
# those are exactly the sites that win the durable first-write race.
r6_maxrows=$(grep -c '"attempt":9,' "$LOG6" 2>/dev/null || true)
if [ "$seed6_ok" != "true" ]; then
  echo "SKIP[6]: this environment cannot seed a file:// remote — early-fallback path untestable here"
elif ! grep -q "breaking out of the local fetch+rebase+push loop early" <<<"$out6"; then
  echo "FAIL[6]: setup was good (merge base $base6) but the early-fallback break never fired — coverage lost"; fail=1
elif [ ! -s "$LOG6" ]; then
  echo "FAIL[6]: early break fired but NO failure row was written"; fail=1
elif [ "${r6_maxrows:-0}" != "0" ]; then
  echo "FAIL[6]: ${r6_maxrows} row(s) recorded attempt=9 (MAX_RETRIES) after an early break at i=1"; fail=1
elif [ "$r6_attempt" != "1" ]; then
  echo "FAIL[6]: expected attempt 1 after an early break at i=1, got '$r6_attempt' (reason '$r6_reason')"; fail=1
elif [[ "$r6_reason" != retries-exhausted\(early-fallback\) && "$r6_reason" != api-fallback-* ]]; then
  echo "FAIL[6]: unexpected reason '$r6_reason' — wanted retries-exhausted(early-fallback) or an api-fallback-* row"; fail=1
else
  echo "PASS[6]: early break records attempt=1 on every post-loop row, reason '$r6_reason'"
fi

if [ "$fail" -ne 0 ]; then
  echo "push-with-retry deadline guard test: FAILED"; exit 1
fi
echo "push-with-retry deadline guard test: OK"
