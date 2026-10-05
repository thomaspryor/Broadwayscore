#!/usr/bin/env bash
# BRO-2879: a LOCAL pre-push hook rejection is deterministic, so push-with-retry.sh
# must stop after the FIRST attempt, exit 4 (distinct from race exhaustion's 1),
# and print the hook's own text as the stated cause. Real script, real git
# remote, real failing pre-push hook. A hook whose text says "non-fast-forward"
# is a recoverable race and must still be retried.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/push-with-retry.sh"
fails=0
pass() { echo "PASS[$1]: $2"; }
fail() { echo "FAIL[$1]: $2"; fails=$((fails + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/push-hook-rej.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
(
  cd "$WORK/repo" || exit 1
  git config user.email t@t.t && git config user.name t
  echo one > f.txt && git add f.txt && git commit -qm one && git push -q origin HEAD:main
  echo local > h.txt && git add h.txt && git commit -qm local
) || { echo "fixture setup failed"; exit 1; }

install_hook() {  # install_hook <message>
  rm -f "$WORK/count"
  cat > "$WORK/repo/.git/hooks/pre-push" <<HOOK
#!/bin/sh
echo x >> "$WORK/count"
# stdout, like scripts/hooks/pre-push: git does not send a pre-push hook's
# stdout to stderr, and a stderr-only capture misread every lost race as a
# deterministic rejection (exit 4, no retry; BRO-4656, three scoring runs).
echo "$1"
exit 1
HOOK
  chmod +x "$WORK/repo/.git/hooks/pre-push"
}
attempts() { if [ -f "$WORK/count" ]; then wc -l < "$WORK/count" | tr -d ' '; else echo 0; fi; }

# 1. deterministic hook rejection: one attempt, exit 4, hook text is the cause.
install_hook "=== PRE-PUSH BLOCKED: help-flag guard (Rule B) for scripts/x.js ==="
( cd "$WORK/repo" && MAX_RETRIES=5 PUSH_API_FALLBACK_DISABLE=1 PUSH_SKIP_LEDGER=1 bash "$TARGET" 5 main ) > "$WORK/run1.log" 2>&1
rc=$?
[ "$rc" = "4" ] && pass 1 "exit 4 on a local hook rejection" || fail 1 "expected exit 4, got $rc"
[ "$(attempts)" = "1" ] && pass 2 "hook ran exactly once (no futile retries)" || fail 2 "hook ran $(attempts) times"
grep -q "hook: === PRE-PUSH BLOCKED: help-flag guard (Rule B)" "$WORK/run1.log" \
  && pass 3 "hook's own text printed as the stated cause" || { fail 3 "hook text missing"; cat "$WORK/run1.log"; }
grep -q "REJECTED BY A LOCAL PRE-PUSH HOOK" "$WORK/run1.log" && pass 4 "names the cause" || fail 4 "cause not named"
grep -q "did NOT run this attempt" "$WORK/run1.log" && fail 5 "fallback disqualifier text must not appear" || pass 5 "no API-fallback misdirection"
grep -q "fetching remote and rebasing" "$WORK/run1.log" && fail 6 "fetch+rebase ran after a hook rejection" || pass 6 "no fetch+rebase cycle"

# 2. a hook that blocks a non-fast-forward push is a race: still retried.
install_hook "=== PRE-PUSH BLOCKED: non-fast-forward push to main ==="
( cd "$WORK/repo" && MAX_RETRIES=2 PUSH_API_FALLBACK_DISABLE=1 PUSH_SKIP_LEDGER=1 bash "$TARGET" 2 main ) > "$WORK/run2.log" 2>&1
rc=$?
[ "$rc" = "1" ] && pass 7 "non-fast-forward hook text exits 1 (race exhaustion)" || fail 7 "expected exit 1, got $rc"
[ "$(attempts)" -ge 2 ] && pass 8 "non-fast-forward hook text is retried ($(attempts) attempts)" || fail 8 "not retried"

# 3. no hook: push succeeds untouched.
rm -f "$WORK/repo/.git/hooks/pre-push"
( cd "$WORK/repo" && PUSH_API_FALLBACK_DISABLE=1 PUSH_SKIP_LEDGER=1 bash "$TARGET" 3 main ) > "$WORK/run3.log" 2>&1
rc=$?
[ "$rc" = "0" ] && pass 9 "clean push still exits 0" || { fail 9 "expected 0, got $rc"; cat "$WORK/run3.log"; }

[ "$fails" = "0" ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
