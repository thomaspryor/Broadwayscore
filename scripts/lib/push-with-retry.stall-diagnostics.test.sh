#!/usr/bin/env bash
# BRO-3213: a killed git_push must say WHICH network phase it died in.
#
# --progress (BRO-2373) already distinguishes local pack generation from the
# Writing-objects transfer phase — but a measured live hang (Opening Night
# Express run 34694172162, 2026-09-12) showed ZERO bytes of --progress output
# for the FULL 90s, ruling out both. git_push_traced() (scripts/lib/
# push-with-retry.sh) adds a GIT_TRACE_CURL_NO_DATA=1 capture routed to its
# OWN temp file (never mixed with --progress's stream) and classifies it via
# scripts/lib/push-diagnostics.js on a timeout-classified failure (rc
# 124/137/143). This test exercises the REAL script against a REAL
# non-routable remote (same fixture pattern as push-rc-diagnosis.test.sh) —
# not a mock — and asserts the phase actually shows up in the run's own log.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/push-with-retry.sh"
fails=0
pass() { echo "PASS[$1]: $2"; }
fail() { echo "FAIL[$1]: $2"; fails=$((fails + 1)); }

if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
  echo "SKIP[1,2,3]: no timeout/gtimeout binary — _timeout fails open, so a push cannot be killed mid-transport here"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP[1,2,3]: no node binary — the diagnostics CLI (push-diagnostics-cli.js) cannot run"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/push-stall-diag.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo one > f.txt && git add f.txt && git commit -qm one && git push -q origin HEAD:main
) >/dev/null 2>&1 || { echo "fixture setup failed"; exit 1; }

LOG="$WORK/run.log"
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo local > h.txt && git add h.txt && git commit -qm local
  # Embed a fake credential in the (non-routable, push-only) remote URL so
  # this run also exercises the redaction path end-to-end, not just
  # classification — a regression that leaked a token here would only show up
  # against a REAL git_push_traced() invocation, not push-diagnostics.test.mjs's
  # unit fixtures (which only feed it synthetic trace text).
  git remote set-url --push origin "https://x-access-token:FAKE_TEST_TOKEN_ABC123@10.255.255.1/blackhole.git"
  PUSH_SKIP_FAILURE_LEDGER=1 \
    MAX_RETRIES=1 GIT_NET_TIMEOUT_SEC=3 PUSH_API_FALLBACK_DISABLE=1 \
    bash "$TARGET" 1 main
) > "$LOG" 2>&1

# Assertions 1 and 2 require this run to have ACTUALLY produced a timeout-killed
# push, because git_push_traced() only classifies a stall phase (push-with-retry.sh
# ~252) for rc 124/137/143. 10.255.255.1 blackholes on most networks (-> rc=124),
# but it is not guaranteed to: GHA ubuntu runners live inside Azure 10.0.0.0/8
# VNets where that address can ICMP-unreachable instead, so git returns 128 in
# under a second and there is no stall phase to classify. That is the documented
# reason push-rc-diagnosis.test.sh:80-96 made its own assertions rc-agnostic, and
# it is not hypothetical here: on a dev machine this fixture produced no hang on
# 1 of 8 consecutive runs (2026-09-13), so asserting unconditionally makes this a
# step that reddens main intermittently for a network accident.
#
# "transport HANG" comes from describe_push_rc() (push-with-retry.sh:292-294),
# which covers EXACTLY the rc set git_push_traced classifies, via an independent
# code path from the stall-phase echo this test asserts on. That independence is
# what makes it a safe guard rather than a self-fulfilling one: deleting the
# stall-phase echo (the regression this test exists to catch) leaves "transport
# HANG" present, so assertion 1 still FAILS rather than silently skipping.
# Verified over 8 runs: the two signals never disagreed.
if grep -q "transport HANG" "$LOG"; then

# 1. A timeout-killed push must report a classified stall phase, not silence.
if grep -q "git-transport stall phase:" "$LOG"; then
  phase="$(grep -m1 "git-transport stall phase:" "$LOG" | sed 's/.*stall phase: //')"
  pass 1 "timed-out push reported a stall phase: $phase"
else
  fail 1 "timed-out push (rc=124/137/143 expected) reported no stall phase at all"
  cat "$LOG"
fi

# 2. Given a non-routable address, the classified phase must be an early one
#    (pre-connect or connect-tls) — never claiming a later phase (e.g.
#    "response-received-then-stalled") that this fixture's blackhole address
#    cannot have reached. A wrong-direction classification would be worse
#    than no classification at all.
if grep -qE "git-transport stall phase: (pre-connect|connect-tls)" "$LOG"; then
  pass 2 "stall phase matches the fixture's actual failure point (never got past connect)"
else
  fail 2 "stall phase classification doesn't match a non-routable-address fixture"
  grep -n "stall phase" "$LOG"
fi

else
  echo "SKIP[1,2]: this host rejected 10.255.255.1 fast instead of blackholing it (no 'transport HANG' in the run log), so no push was killed mid-transport and there is no stall phase to classify. Assertion 3 still runs."
fi  # end HANG guard

# 3. The embedded fake credential must never appear in the log, even inside
#    the echoed curl-trace excerpt.
if grep -q "FAKE_TEST_TOKEN_ABC123" "$LOG"; then
  fail 3 "embedded credential leaked into the log via the curl-trace excerpt"
else
  pass 3 "no credential leakage in the curl-trace excerpt"
fi

if [ "$fails" -eq 0 ]; then
  echo "=== push-with-retry.stall-diagnostics.test.sh PASSED ==="
  exit 0
fi
echo "=== push-with-retry.stall-diagnostics.test.sh FAILED ($fails) ==="
exit 1
