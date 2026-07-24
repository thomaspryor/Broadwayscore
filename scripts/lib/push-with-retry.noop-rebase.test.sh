#!/usr/bin/env bash
# Integration test for the #394 no-op-rebase root-cause fix in push-with-retry.sh.
#
# The bug: under actions/checkout's SHA-pinned fetch refspec, a bare
# `git fetch origin main` updates FETCH_HEAD but NOT refs/remotes/origin/main, so
# `git rebase -X theirs origin/main` targets a STALE base, integrates nothing
# ("Current branch main is up to date"), and the retry loop re-pushes the same stale
# ref — rejected for all 7 attempts. The alert-ledger never persisted from CI.
#
# This test reproduces the EXACT condition (SHA-pinned refspec + a concurrent commit
# that advanced origin/main after checkout) and asserts the FIXED script lands the
# runner's commit on origin — i.e. the explicit-destination fetch defeats the no-op.
#
# Run: bash scripts/lib/push-with-retry.noop-rebase.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
PROGRESS_CLI="$SCRIPT_DIR/push-rebase-progress.js"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

# ── Bare origin seeded with an alert-ledger ──────────────────────────────────
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/seed"
gitc "$TMP/seed" config user.email t@t.t; gitc "$TMP/seed" config user.name t
gitc "$TMP/seed" commit -q --allow-empty -m base
mkdir -p "$TMP/seed/data/audit"
printf '{"conditions":{}}\n' > "$TMP/seed/data/audit/alert-ledger.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m seed-ledger
gitc "$TMP/seed" branch -M main; gitc "$TMP/seed" push -q "$TMP/origin.git" main
OLDTIP=$(git --git-dir="$TMP/origin.git" rev-parse main)

# ── Runner: actions/checkout@v5-style shallow, SHA-PINNED fetch refspec ───────
git init -q "$TMP/runner"
gitc "$TMP/runner" config user.email t@t.t; gitc "$TMP/runner" config user.name t
gitc "$TMP/runner" remote add origin "$TMP/origin.git"
gitc "$TMP/runner" -c protocol.version=2 fetch --no-tags --prune --depth=1 origin "+$OLDTIP:refs/remotes/origin/main" >/dev/null 2>&1
# THE trigger: pin the persisted refspec to the trigger SHA (what checkout does),
# so a later bare `git fetch origin main` won't advance refs/remotes/origin/main.
gitc "$TMP/runner" config remote.origin.fetch "+$OLDTIP:refs/remotes/origin/main"
gitc "$TMP/runner" checkout -q -B main refs/remotes/origin/main

# ── A concurrent writer advances origin/main AFTER checkout (busy main) ───────
printf '{"c":1}\n' > "$TMP/seed/other.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m concurrent-commit
gitc "$TMP/seed" push -q "$TMP/origin.git" main
NEWTIP=$(git --git-dir="$TMP/origin.git" rev-parse main)

# ── Runner writes the ledger + commits (the "Commit alert-router ledger" step) ─
printf '{"conditions":{"test-yml:main-streak":{"lastNotified":123}}}\n' > "$TMP/runner/data/audit/alert-ledger.json"
gitc "$TMP/runner" add -A; gitc "$TMP/runner" commit -q -m "data: alert-router ledger update"

# ── Case 1: fixed push-with-retry.sh must LAND the ledger commit on origin ────
out=$( cd "$TMP/runner" && PUSH_FAILURE_LOG="$TMP/failures.jsonl" bash "$PUSH_SCRIPT" 7 main 2>&1 ); code=$?
LANDED=$(git --git-dir="$TMP/origin.git" show main:data/audit/alert-ledger.json 2>/dev/null || echo "")
if [ "$code" -ne 0 ]; then
  echo "FAIL[1]: expected exit 0 (push landed), got $code. Output:"; echo "$out" | sed 's/^/    /'; fail=1
elif ! grep -q "test-yml:main-streak" <<<"$LANDED"; then
  echo "FAIL[1]: origin/main ledger does NOT contain the run's write — the #394 no-op regressed."
  echo "    origin ledger now: $LANDED"; fail=1
else
  # And the concurrent writer's commit must still be present (we rebased on top).
  if git --git-dir="$TMP/origin.git" show main:other.json >/dev/null 2>&1; then
    echo "PASS[1]: fixed script landed the ledger commit ON TOP of the concurrent commit (no-op defeated)"
  else
    echo "FAIL[1]: ledger landed but the concurrent commit was lost (non-fast-forward clobber)"; fail=1
  fi
fi

# ── Case 2: the loud-abort decision the script wires is the tested predicate ──
# Exact invocation the helper uses. NOOP => history claimed success but remote not
# incorporated (the impossible push) => abort.
verdict_noop=$(node "$PROGRESS_CLI" --remote-in-history=false --history-changed=true 2>/dev/null); c1=$?
verdict_ok=$(node "$PROGRESS_CLI" --remote-in-history=true --history-changed=true 2>/dev/null); c2=$?
verdict_fail=$(node "$PROGRESS_CLI" --remote-in-history=false --history-changed=false 2>/dev/null); c3=$?
if [ "$verdict_noop" = "NOOP" ] && [ "$c1" -eq 3 ] \
   && [ "$verdict_ok" = "OK" ] && [ "$c2" -eq 0 ] \
   && [ "$verdict_fail" = "OK" ] && [ "$c3" -eq 0 ]; then
  echo "PASS[2]: no-op progress predicate CLI (loud-abort trigger) behaves per contract"
else
  echo "FAIL[2]: predicate CLI contract broken: noop='$verdict_noop'($c1) ok='$verdict_ok'($c2) fail='$verdict_fail'($c3)"; fail=1
fi

# ── Case 3: the EXACT bash wrapper the helper uses must match "NOOP" ──────────
# Regression guard for the ship-check #394 finding: the CLI exits non-zero (3) on a
# no-op, so a `|| echo OK` fallback would APPEND "OK" (→ "NOOP\nOK") and the guard
# would silently never fire. This asserts the `|| true` idiom in push-with-retry.sh
# captures exactly "NOOP" (fires) on a no-op and "" (fail-open) on a node crash.
wrapped_noop=$(node "$PROGRESS_CLI" --remote-in-history=false --history-changed=true 2>/dev/null || true)
if [ "$wrapped_noop" = "NOOP" ]; then
  echo "PASS[3]: helper's '|| true' wrapper captures exactly 'NOOP' (guard fires) — not 'NOOP\\nOK'"
else
  echo "FAIL[3]: wrapper captured '$wrapped_noop' (≠ 'NOOP') — the guard would ship INERT. Use '|| true', not '|| echo OK'."; fail=1
fi

# And assert the shipped helper actually uses '|| true', never '|| echo OK'.
if grep -q 'push-rebase-progress.js.*|| echo OK' "$SCRIPT_DIR/push-with-retry.sh"; then
  echo "FAIL[4]: push-with-retry.sh uses '|| echo OK' after the progress CLI — appends OK to NOOP, guard never fires."; fail=1
else
  echo "PASS[4]: push-with-retry.sh does not use the inert '|| echo OK' wrapper"
fi

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.noop-rebase.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.noop-rebase.test.sh PASSED ==="
