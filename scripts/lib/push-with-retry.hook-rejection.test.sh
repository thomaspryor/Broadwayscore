#!/usr/bin/env bash
# BRO-2879: a LOCAL pre-push hook rejection is deterministic, so push-with-retry.sh
# must stop after the FIRST attempt, exit 4 (distinct from race exhaustion's 1),
# and print the hook's own text as the stated cause. Real script, real git
# remote, real failing pre-push hook. A hook whose text says "non-fast-forward"
# is a recoverable race and must still be retried.
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

# 4. BRO-5306: GitHub 403 "Permission to ... denied" (token lacks contents:
# write). No pre-push hook (as in CI). A stub git on PATH fails every `push`
# with the real 2026-10-13 stderr and delegates everything else to real git.
REAL_GIT="$(command -v git)"
mkdir -p "$WORK/stub"
cat > "$WORK/stub/git" <<STUB
#!/bin/sh
for a in "\$@"; do
  if [ "\$a" = "push" ]; then
    echo x >> "$WORK/count"
    echo "remote: Permission to thomaspryor/Broadwayscore.git denied to github-actions[bot]." >&2
    echo "fatal: unable to access 'https://github.com/thomaspryor/Broadwayscore/': The requested URL returned error: 403" >&2
    exit 128
  fi
done
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$WORK/stub/git"
rm -f "$WORK/count" "$WORK/fail4.jsonl"
( cd "$WORK/repo" && echo more > p.txt && git add p.txt && git commit -qm perm \
  && PATH="$WORK/stub:$PATH" MAX_RETRIES=5 PUSH_FAILURE_LOG="$WORK/fail4.jsonl" PUSH_SKIP_FAILURE_LEDGER=1 PUSH_SKIP_LEDGER=1 \
     bash "$TARGET" 5 main ) > "$WORK/run4.log" 2>&1
rc=$?
[ "$rc" = "4" ] && pass 10 "exit 4 on a permission-denied 403" || { fail 10 "expected exit 4, got $rc"; cat "$WORK/run4.log"; }
[ "$(attempts)" = "1" ] && pass 11 "pushed exactly once (no futile retries)" || fail 11 "push ran $(attempts) times"
grep -q "::error::.*contents: write" "$WORK/run4.log" && pass 12 "::error:: names contents: write" || fail 12 "contents: write not named"
grep -q "fetching remote and rebasing" "$WORK/run4.log" && fail 13 "fetch+rebase ran after a 403" || pass 13 "no fetch+rebase cycle"
grep -q "trying the Git Data API fallback\|breaking out of the local fetch+rebase+push loop early" "$WORK/run4.log" \
  && fail 15 "API fallback was attempted after a 403" || pass 15 "Git Data API fallback skipped"
grep -q '"reason":"permission-denied"' "$WORK/fail4.jsonl" 2>/dev/null \
  && pass 14 "failure ledger reason is permission-denied" || { fail 14 "ledger row missing"; cat "$WORK/fail4.jsonl" 2>/dev/null; }

[ "$fails" = "0" ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
