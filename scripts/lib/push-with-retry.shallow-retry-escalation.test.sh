#!/usr/bin/env bash
# Integration test for task #1849: the shallow-fetch bound
# (_shallow_base_sha/_shallow_base_epoch) is memoized ONCE per script run
# (intentional — see push-with-retry.sh's "Computed ONCE for the whole run"
# comment, so a SUCCESSFUL bounded fetch doesn't creep the window wider on
# every retry for no benefit). But that memoization also applied when the
# bounded fetch FAILED outright: a real incident (data-health-check.yml run
# 32399332590, 2026-08-20) hit a shallow-bounded fetch that failed FAST
# (rc=128, not a 124 timeout) on BOTH the explicit-refspec --shallow-since
# form and the bare-form --deepen=200 fallback, and every one of 25 retries
# recomputed and reissued the byte-identical bound from the same memoized
# epoch — 25/25 identical failures, main never pushed.
#
# This test simulates a remote that REJECTS the first-choice bound
# (--shallow-since=@... or the exact --deepen=200 fallback) with rc=128 but
# accepts a WIDER one, via a `git` test-double inserted at the front of PATH
# that proxies every other call straight to the real binary. It asserts the
# fixed script:
#   1. logs a DIFFERENT (wider) bound on the second attempt, not the
#      identical rejected one, and
#   2. the push ultimately LANDS (the wider bound succeeds).
#
# Run: bash scripts/lib/push-with-retry.shallow-retry-escalation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

REAL_GIT_BIN="$(command -v git)"

# ── `git` test double: rejects the FIRST-choice shallow bound, accepts wider
# ones and everything else, so the real invariant under test (does the SECOND
# attempt actually widen?) is isolated from real network/remote behavior. ──
mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/git" <<WRAPPER
#!/usr/bin/env bash
is_fetch=false
reject=false
for a in "\$@"; do
  case "\$a" in
    fetch) is_fetch=true ;;
    --shallow-since=*) reject=true ;;
    --deepen=200) reject=true ;;
  esac
done
if [ "\$is_fetch" = "true" ] && [ "\$reject" = "true" ]; then
  echo "fatal: no commits selected for shallow requests" >&2
  exit 128
fi
exec "$REAL_GIT_BIN" "\$@"
WRAPPER
chmod +x "$TMP/fakebin/git"

# ── Bare origin with real history (shallow bounding needs something to bound) ──
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/seed"
gitc "$TMP/seed" config user.email t@t.t; gitc "$TMP/seed" config user.name t
for i in $(seq 1 5); do
  printf '{"n":%d}\n' "$i" > "$TMP/seed/f$i.json"
  gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m "seed $i"
done
gitc "$TMP/seed" branch -M main; gitc "$TMP/seed" push -q "$TMP/origin.git" main

# ── Runner: shallow clone (depth=1), like actions/checkout's default. Local
# filesystem paths silently IGNORE --depth ("--depth is ignored in local
# clones; use file:// instead") — the explicit file:// form is required to
# actually get a shallow clone here. ──────────────────────────────────────────
git clone -q --depth=1 --no-tags "file://$TMP/origin.git" "$TMP/runner"
gitc "$TMP/runner" config user.email t@t.t; gitc "$TMP/runner" config user.name t

# ── Concurrent writer advances origin AFTER checkout (the push-rejection) ─────
printf '{"c":1}\n' > "$TMP/seed/other.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m concurrent-commit
gitc "$TMP/seed" push -q "$TMP/origin.git" main

# ── Runner makes its own local commit to push ──────────────────────────────────
printf '{"run":1}\n' > "$TMP/runner/data.json"
gitc "$TMP/runner" add -A; gitc "$TMP/runner" commit -q -m "runner commit"

out=$(
  cd "$TMP/runner" && \
  PATH="$TMP/fakebin:$PATH" \
  GITHUB_ACTIONS=true \
  PUSH_API_FALLBACK_DISABLE=1 \
  PUSH_SKIP_UNSHALLOW=1 \
  GIT_NET_TIMEOUT_SEC=15 \
  PUSH_DEADLINE_SEC=90 \
  bash "$PUSH_SCRIPT" 5 main 2>&1
); code=$?

if ! grep -q "bounding with --shallow-since" <<<"$out"; then
  echo "FAIL[1]: first attempt didn't use the smart shallow-since bound as expected. Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  echo "PASS[1]: first attempt used the smart --shallow-since bound"
fi

if ! grep -q "Escalating for the next retry" <<<"$out"; then
  echo "FAIL[2]: escalation warning never fired after the first bound was rejected. Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  echo "PASS[2]: escalation triggered after the first bound failed fast (not a timeout)"
fi

if ! grep -q "escalating to --deepen=2000" <<<"$out"; then
  echo "FAIL[3]: second attempt did not widen to --deepen=2000 — likely reissued the identical rejected bound (the task #1849 regression). Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  echo "PASS[3]: second attempt escalated to a WIDER, DIFFERENT bound (--deepen=2000) instead of repeating the rejected one"
fi

# The identical-bound-forever regression: the rejected --shallow-since/--deepen=200
# form must NOT be reissued on a THIRD attempt once escalation has kicked in.
if grep -A2 "escalating to --deepen=2000" <<<"$out" | grep -q -- "--shallow-since"; then
  echo "FAIL[4]: a shallow-since bound reappeared after escalation started — the identical-bound regression is back."; fail=1
else
  echo "PASS[4]: no shallow-since bound reappears once escalation has started"
fi

if [ "$code" -ne 0 ]; then
  echo "FAIL[5]: push did not land (exit $code) even though the wider bound should succeed against the fake remote. Output:"; echo "$out" | sed 's/^/    /'; fail=1
else
  LANDED=$(git --git-dir="$TMP/origin.git" show main:data.json 2>/dev/null || echo "")
  if [ -n "$LANDED" ]; then
    echo "PASS[5]: push ultimately landed on origin/main once the bound escalated wide enough"
  else
    echo "FAIL[5]: script exited 0 but the runner's commit is not on origin/main"; fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.shallow-retry-escalation.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.shallow-retry-escalation.test.sh PASSED ==="
