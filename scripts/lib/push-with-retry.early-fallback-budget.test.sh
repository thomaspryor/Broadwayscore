#!/usr/bin/env bash
# Integration test for the early-fallback retry-budget defect in
# push-with-retry.sh (BRO-3663 / card #431).
#
# THE BUG THIS PINS
# -----------------
# push-with-retry.sh breaks OUT of the local fetch+rebase+push retry loop early
# once $PUSH_API_FALLBACK_AFTER_ATTEMPTS local attempts have failed, on the
# theory that the Git Data API fallback is a better use of the remaining time
# than more local attempts. That trade is only sound if the fallback can
# actually run.
#
# $_PUSH_API_FALLBACK_ELIGIBLE (push-with-retry.sh, near line 832) is
# REPO/CONFIG-level only: PUSH_API_FALLBACK_DISABLE unset, not the
# broadway-review-texts repo, a resolvable SCRIPT_ENTRY_BASE, push-via-git-api.sh
# present. It knows nothing about WHICH PATHS the outgoing diff touches.
#
# The diff-PATH disqualifier runs much later, inside the post-loop fallback
# block, and rejects the fallback when the outgoing diff touches a
# union-merge-MANAGED file, shows.json/reviews.json, or a `data/audit/` path
# that is not registered apiFallbackSafe/apiFallbackMerge in
# core-data-merge-registry.js.
#
# So for a caller pushing an unregistered `data/audit/` path the sequence was:
# break the loop early at attempt 3 -> discover the fallback is disqualified ->
# hard-fail, with the remaining budgeted local attempts never used. Observed in
# production as "Audit Aggregator Review Gap" run 34855239166:
#   ::error::All push attempts failed after 3 of 5 budgeted attempt(s) (early-fallback)
# The underlying attempt failures there were transport HANGS (rc=124), i.e.
# exactly the class more retries exist to ride out.
#
# BRO-3071 papered over the instance by registering 86 single-writer
# data/audit/ files as apiFallbackSafe. 360 of the 476 data/audit/*.json files
# on disk are still unregistered, so the cliff is still reachable — this test
# pins the BEHAVIOUR rather than any one file's registry status.
#
# WHAT IS ASSERTED
#   1. Unregistered data/audit/ path (fallback will be path-disqualified):
#      the full local retry budget is spent; no "early-fallback" abort.
#   2. Control — an ordinary non-data/audit/ path (fallback NOT
#      path-disqualified): the early break STILL fires, so the fix does not
#      silently disable the task #1792 optimisation for the callers it helps.
#
# Run: bash scripts/lib/push-with-retry.early-fallback-budget.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# A work repo whose `origin` is a real local bare repo — so `origin/main`
# resolves and SCRIPT_ENTRY_BASE is non-empty (a fallback prerequisite) — but
# whose every push is REJECTED by a pre-receive hook. A rejection rather than a
# network hang keeps the test fast and deterministic while still driving the
# same failed-attempt path.
setup_case() {
  local name="$1" rel_path="$2"
  local bare="$TMPROOT/$name.git" work="$TMPROOT/$name"

  git init -q --bare "$bare"
  git init -q "$work"
  git -C "$work" config user.email t@t.t
  git -C "$work" config user.name t
  git -C "$work" symbolic-ref HEAD refs/heads/main
  git -C "$work" commit -q --allow-empty -m init
  git -C "$work" remote add origin "$bare"
  # T3: the seed push MUST succeed. If a sandbox refuses file:// pushes,
  # origin/main never exists -> SCRIPT_ENTRY_BASE is empty -> the fallback is
  # ineligible -> no early break ever fires -> Case 1 would pass VACUOUSLY,
  # even against unfixed code. Assert it rather than discard the error.
  if ! git -C "$work" push -q origin main 2>/dev/null; then
    echo "SETUP-FAIL[$name]: seed push to the bare file:// remote failed — cannot establish origin/main" >&2
    return 1
  fi
  if ! git -C "$work" rev-parse --verify --quiet origin/main >/dev/null; then
    echo "SETUP-FAIL[$name]: origin/main does not resolve after the seed push — SCRIPT_ENTRY_BASE would be empty" >&2
    return 1
  fi

  # Reject every push from here on.
  printf '#!/bin/sh\nexit 1\n' > "$bare/hooks/pre-receive"
  chmod +x "$bare/hooks/pre-receive"

  # The outgoing change. Committed (not just staged) so the diff
  # SCRIPT_ENTRY_BASE..HEAD the disqualifier inspects is non-empty.
  mkdir -p "$work/$(dirname "$rel_path")"
  printf '{ "generated": "by push-with-retry.early-fallback-budget.test.sh" }\n' > "$work/$rel_path"
  git -C "$work" add "$rel_path"
  git -C "$work" commit -q -m "test: outgoing change touching $rel_path"

  echo "$work"
}

# T2: house pattern (deadline.test.sh) — divert the durable failure ledger to a
# temp file so record_push_failure never attempts its real CAS write, and so the
# recorded reason/attempt can be asserted rather than inferred from stdout.
LEDGER="$TMPROOT/push-failures.jsonl"

row_field() {  # row_field <file> <key>  — last row's value for <key>
  [ -s "$1" ] || return 1
  tail -1 "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p"
}

run_push() {
  local work="$1" deadline="${2:-600}"
  # MAX_RETRIES=5 and AFTER_ATTEMPTS=3 reproduce the production shape exactly
  # (run 34855239166: "3 of 5 budgeted"). The default deadline is set well clear
  # of the ~35-50s the loop's own hardcoded backoff spends over 5 attempts, so
  # it is the fallback logic under test and never the deadline break.
  ( cd "$work" && \
    PUSH_DEADLINE_SEC="$deadline" \
    PUSH_API_FALLBACK_AFTER_ATTEMPTS=3 \
    PUSH_API_MAX_RETRIES=1 \
    GIT_NET_TIMEOUT_SEC=10 \
    PUSH_SKIP_FAILURE_LEDGER=1 \
    PUSH_FAILURE_LOG="$LEDGER" \
    bash "$PUSH_SCRIPT" 5 main 2>&1 )
}

# ── Case 1: unregistered data/audit/ path — the regression ────────────────────
# data/audit/<name>.json is deliberately a path that is NOT in the real
# registry's apiFallbackSafe/apiFallbackMerge lists. The disqualifier resolves
# the registry through push-with-retry.sh's own SCRIPT_DIR, so this consults
# the REAL core-data-merge-registry.js, not a fixture.
UNREGISTERED="data/audit/push-with-retry-early-fallback-budget-fixture.json"
if node -e '
  const r = require(process.argv[1]);
  const f = process.argv[2];
  const hit = [...r.API_FALLBACK_SAFE, ...r.API_FALLBACK_MERGE]
    .some((m) => f.endsWith(m.file.replace(/^data\//, "")));
  process.exit(hit ? 1 : 0);
' "$SCRIPT_DIR/reconcile-merged-json.js" "$UNREGISTERED"; then
  rm -f "$LEDGER"
  if ! W1=$(setup_case case1 "$UNREGISTERED"); then
    echo "FAIL[1]: setup failed — see SETUP-FAIL above"; fail=1; W1=""
  fi
  out1=$(run_push "$W1"); code1=$?

  if [ -z "$W1" ]; then
    : # setup already failed and was reported
  elif [ "$code1" -ne 1 ]; then
    echo "FAIL[1]: expected exit 1 (every push is rejected), got $code1"; fail=1
  elif ! grep -q "skipping Git Data API fallback" <<<"$out1"; then
    echo "FAIL[1]: precondition not met — the fallback was NOT path-disqualified,"
    echo "         so this case cannot exercise the defect. Output:"; echo "$out1"; fail=1
  elif grep -q "budgeted attempt(s) (early-fallback)" <<<"$out1"; then
    echo "FAIL[1]: REGRESSION — broke out of the retry loop early for a fallback"
    echo "         that was then path-disqualified, discarding the remaining local"
    echo "         attempts. Offending line:"
    grep "All push attempts failed" <<<"$out1" | sed 's/^/           /'; fail=1
  elif ! grep -q "All push attempts failed after 5 of 5 budgeted attempt(s)" <<<"$out1"; then
    echo "FAIL[1]: expected the full 5-attempt budget to be spent. Got:"
    grep "All push attempts failed" <<<"$out1" | sed 's/^/           /'
    echo "$out1" | tail -30; fail=1
  elif ! grep -q "NOT breaking out early for the Git Data API fallback" <<<"$out1"; then
    echo "FAIL[1]: the budget was spent but the operator was never told WHY the"
    echo "         early break was suppressed. Output:"; echo "$out1" | tail -20; fail=1
  elif [ "$(row_field "$LEDGER" reason)" != "retries-exhausted" ] \
       || [ "$(row_field "$LEDGER" attempt)" != "5" ]; then
    echo "FAIL[1]: failure ledger row disagrees with the run —"
    echo "         reason=$(row_field "$LEDGER" reason) attempt=$(row_field "$LEDGER" attempt)"
    echo "         expected reason=retries-exhausted attempt=5"; fail=1
  else
    echo "PASS[1]: path-disqualified fallback no longer costs the remaining retry budget (5 of 5 spent, ledger reason=retries-exhausted)"
  fi
else
  echo "FAIL[1]: fixture path $UNREGISTERED is registered apiFallbackSafe/apiFallbackMerge —"
  echo "         pick a different unregistered path, this case is now vacuous."; fail=1
fi

# ── Case 2: control — early break must still fire when it is useful ───────────
# An ordinary source path is not touched by the MANAGED/shows.json/reviews.json/
# data-audit disqualifier, so the fallback IS reachable and the task #1792
# early-trigger optimisation must be preserved.
rm -f "$LEDGER"
if ! W2=$(setup_case case2 "docs/push-with-retry-early-fallback-budget-fixture.md"); then
  echo "FAIL[2]: setup failed — see SETUP-FAIL above"; fail=1; W2=""
fi
out2=$(run_push "$W2"); code2=$?

if [ -z "$W2" ]; then
  : # setup already failed and was reported
elif [ "$code2" -ne 1 ]; then
  echo "FAIL[2]: expected exit 1 (every push is rejected), got $code2"; fail=1
elif grep -q "skipping Git Data API fallback" <<<"$out2"; then
  echo "FAIL[2]: control path was unexpectedly path-disqualified — case is vacuous. Output:"
  echo "$out2" | tail -30; fail=1
elif ! grep -q "breaking out of the local fetch+rebase+push loop early" <<<"$out2"; then
  echo "FAIL[2]: the early-fallback break did NOT fire for a fallback-eligible diff —"
  echo "         the fix over-corrected and disabled task #1792 for everyone. Output:"
  echo "$out2" | tail -30; fail=1
else
  echo "PASS[2]: early-fallback break still fires when the fallback is genuinely reachable"
fi

# ── Case 3: the deadline still bounds the run when attempts HANG ──────────────
# The behaviour this fix introduces is "spend the remaining attempts", and
# spending them costs WALL-CLOCK. Cases 1-2 use instant pre-receive rejections,
# against which the deadline can never bind — so they cannot distinguish
# "5 attempts made" from "5 attempts made in time". This case reproduces the
# real production failure mode instead: a transport that HANGS (the rc=124 class
# from run 34855239166, via git's ext:: transport running a sleep AS the
# transport) on an unregistered data/audit/ path, with a deadline tight enough
# that it must bind first. The fix must never let a hang-bound caller run past
# its own deadline.
#
# Needs a timeout/gtimeout binary — push-with-retry.sh's _timeout wrapper fails
# OPEN without one (documented there), which would make this hang for the full
# sleep. SKIP rather than hang on hosts lacking it (stock macOS).
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  rm -f "$LEDGER"
  if ! W3=$(setup_case case3 "$UNREGISTERED"); then
    echo "FAIL[3]: setup failed — see SETUP-FAIL above"; fail=1; W3=""
  else
    git -C "$W3" remote set-url origin "ext::sh -c 'sleep 120'"
  fi

  if [ -n "$W3" ]; then
    start3=$SECONDS
    out3=$(run_push "$W3" 20); code3=$?
    elapsed3=$(( SECONDS - start3 ))

    if [ "$code3" -ne 1 ]; then
      echo "FAIL[3]: expected exit 1, got $code3 (elapsed ${elapsed3}s)"; fail=1
    elif [ "$elapsed3" -ge 120 ]; then
      echo "FAIL[3]: took ${elapsed3}s — the suppressed early break let a hanging"
      echo "         caller run past its deadline instead of being bounded"; fail=1
    elif ! grep -q "overall deadline .* exceeded" <<<"$out3"; then
      echo "FAIL[3]: no deadline warning — the run was not deadline-bounded. Output:"
      echo "$out3" | tail -20; fail=1
    elif ! grep -q "budgeted attempt(s) (deadline)" <<<"$out3"; then
      echo "FAIL[3]: expected the exit to be filed as (deadline). Got:"
      grep "All push attempts failed" <<<"$out3" | sed 's/^/           /'; fail=1
    else
      echo "PASS[3]: a hanging caller on a disqualified path is still bounded by its deadline (${elapsed3}s, filed as deadline)"
    fi
  fi
else
  echo "SKIP[3]: no timeout/gtimeout binary — push-with-retry.sh's _timeout wrapper fails open here"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"; exit 1
fi
echo "All early-fallback budget tests passed"
