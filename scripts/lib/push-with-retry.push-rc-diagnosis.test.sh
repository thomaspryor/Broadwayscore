#!/usr/bin/env bash
# BRO-2732: push failure diagnosis — a failed `git push` must say WHY.
#
# git_push() runs git under `_timeout ... -k 10`. When timeout kills git
# mid-transport git prints NOTHING of its own, so a fast REJECTION (git's stderr
# visible, ~1s) and a full-GIT_NET_TIMEOUT_SEC transport HANG (silent) used to
# produce IDENTICAL log text. That is why rebuild-reviews.yml's push failures
# could not be diagnosed from a run log — BRO-2732's defect #2, and the same
# blindness task #1810 hit on update-show-status.yml for 4+ days.
#
# Test 1 and 2 exercise the REAL script against a REAL git remote (a local bare
# repo for fetch, a non-routable push URL to force the hang) — not a mock — and
# assert both call sites classify the exit code.
#
# Test 3 is a structural guard for the bug class an independent review caught in
# the first draft of this very change: `local` is only valid inside a function,
# and the retry loop these branches live in is at TOP LEVEL. Under this script's
# `set -euo pipefail` (line 29) a stray `local` aborts the whole script and fires
# the EXIT trap, converting a TRANSIENT push failure into a hard exit that skips
# every remaining retry AND the Git Data API fallback. Static, so it stays cheap.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/push-with-retry.sh"
fails=0
pass() { echo "PASS[$1]: $2"; }
fail() { echo "FAIL[$1]: $2"; fails=$((fails + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/push-rc-diag.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- fixture: a real bare remote, a clone, and a divergent remote commit so the
# script is forced through fetch + conflict resolution + a post-resolution push.
git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo one > f.txt && git add f.txt && git commit -qm one && git push -q origin HEAD:main
) || { echo "fixture setup failed"; exit 1; }
git clone -q "$WORK/origin.git" "$WORK/other" 2>/dev/null
(
  cd "$WORK/other" || exit 1
  git config user.email t@t.t && git config user.name t
  echo two > g.txt && git add g.txt && git commit -qm two && git push -q origin HEAD:main
) || { echo "fixture setup failed"; exit 1; }

# Push goes to a non-routable address so the push HANGS and is killed by
# _timeout; fetch keeps using the working local remote.
LOG="$WORK/run.log"
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo local > h.txt && git add h.txt && git commit -qm local
  git remote set-url --push origin https://10.255.255.1/blackhole.git
  MAX_RETRIES=2 GIT_NET_TIMEOUT_SEC=3 PUSH_API_FALLBACK_DISABLE=1 \
    bash "$TARGET" 2 main
) > "$LOG" 2>&1

# 1. The pre-resolution push (the FIRST and most common push of every attempt)
#    must name the timeout. Before BRO-2732 this site had no else branch at all:
#    it fell through to a generic "Push failed (attempt N/M)" naming neither the
#    exit code nor the elapsed time.
if grep -q "Pre-resolution push (attempt 1) FAILED in .*rc=124" "$LOG" \
   && grep -q "Pre-resolution push (attempt 1) FAILED in .*transport HANG, not a rejection" "$LOG"; then
  pass 1 "pre-resolution push timeout is reported as rc=124 + transport HANG"
else
  fail 1 "pre-resolution push timeout not classified"
  grep -n "Pre-resolution" "$LOG" | head -3
fi

# 2. The post-resolution push — the exact line BRO-2732 names — must classify its
#    exit code too. Any non-timeout code must NOT be described as a hang.
if grep -q "Post-resolution push (attempt 1) FAILED in .*rc=" "$LOG"; then
  post_line="$(grep -m1 "Post-resolution push (attempt 1) FAILED" "$LOG")"
  if grep -q "rc=124\|rc=137" <<< "$post_line"; then
    grep -q "transport HANG" <<< "$post_line" \
      && pass 2 "post-resolution push timeout classified as a hang" \
      || fail 2 "post-resolution timeout rc not described as a hang: $post_line"
  else
    grep -q "transport HANG" <<< "$post_line" \
      && fail 2 "non-timeout rc wrongly described as a hang: $post_line" \
      || pass 2 "post-resolution push non-timeout rc reported without claiming a hang"
  fi
else
  fail 2 "post-resolution push failure printed no exit code"
  grep -n "Post-resolution" "$LOG" | head -3
fi

# 3. Structural: no `local` outside a function body anywhere in the target.
#    Tracks brace depth of `name() {` ... `}` blocks. A `local` at depth 0 is the
#    hard-abort class described in this file's header.
if awk '
  # Function opener. Deliberately does NOT anchor the end of the line: this repo
  # writes `_timeout() {  # _timeout <secs> <cmd...> — fail-open ...`, and an
  # end-anchored pattern misses it, which made this very check report a false
  # positive on _timeout()s own legitimate `local secs="$1"`.
  /^[A-Za-z_][A-Za-z_0-9]*\(\)/ { infn = 1 }
  infn && /^\}[[:space:]]*$/ { infn = 0; next }
  !infn && /^[[:space:]]*local[[:space:]]/ { print NR": "$0; found = 1 }
  END { exit(found ? 1 : 0) }
' "$TARGET"; then
  pass 3 "no 'local' outside a function body (would hard-abort under set -e)"
else
  fail 3 "'local' used outside a function body — aborts the whole script under set -euo pipefail"
fi

# 4. Every git_push call site is preceded by a push_start assignment, so the
#    elapsed-time report can never reference an unset var under `set -u` (the
#    second hard-abort the review caught).
sites="$(grep -c "if git_push origin" "$TARGET")"
starts="$(grep -c "push_start=\$SECONDS" "$TARGET")"
if [ "$sites" -gt 0 ] && [ "$sites" -eq "$starts" ]; then
  pass 4 "all $sites git_push call site(s) have a matching push_start (set -u safe)"
else
  fail 4 "git_push sites=$sites but push_start assignments=$starts — an unset push_start aborts under set -u"
fi

if [ "$fails" -eq 0 ]; then
  echo "=== push-with-retry.push-rc-diagnosis.test.sh PASSED ==="
  exit 0
fi
echo "=== push-with-retry.push-rc-diagnosis.test.sh FAILED ($fails) ==="
exit 1
