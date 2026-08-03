#!/usr/bin/env bash
#
# Fault-injection test for merge-worktree-to-main.sh's content-survival check
# (card 3b1637c5 — the task #684 T12 double-drop).
#
# THE BUG THIS PINS: the script's per-file verify was `git cat-file -e
# origin/main:$f` — existence only. A concurrent writer that reverts our lines
# but leaves the path in place passed every check the script made (our merge
# commit IS an ancestor of origin's tip; the file DOES exist), so the script
# printed "✓" and exited 0 while the pushed lines were gone from origin.
#
# Mirrors the shape of scripts/lib/push-with-retry.content-drop.test.sh: build
# real git repos in a temp dir, run the real script against a real bare
# "origin", and inject the revert from a second clone.
#
# Cases:
#   1. clean merge, nobody interferes            -> exit 0 (no false positive)
#   2. concurrent writer reverts our lines       -> exit 1 + "REVERTED"
#   3. kill switch set during case 2             -> exit 0 (escape hatch works)
#
# Run: bash scripts/lib/merge-worktree-to-main.content-drop.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/merge-worktree-to-main.sh"
[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

# Build: bare origin + a "main" clone (where the script runs) + a second clone
# standing in for the concurrent session. $1 = case name.
setup() {
  local name="$1" d="$TMP/$1"
  rm -rf "$d"; mkdir -p "$d"

  git init --bare -q -b main "$d/origin.git"

  git clone -q "$d/origin.git" "$d/main"
  git -C "$d/main" config user.email t@t.t
  git -C "$d/main" config user.name t
  # The script copies itself out of SCRIPT_DIR, so the fixture repo needs the
  # real script + the real helper it calls — otherwise the check silently
  # no-ops on the `[ -f .../push-content-survival.js ]` guard and the test
  # would pass vacuously.
  mkdir -p "$d/main/scripts/lib"
  cp "$SCRIPT" "$d/main/scripts/merge-worktree-to-main.sh"
  cp "$REPO_ROOT/scripts/lib/push-content-survival.js" "$d/main/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/push-mutex.sh" "$d/main/scripts/lib/"
  # The range-scoped push audits (card #835) are a DIFFERENT gate with its own
  # coverage (scripts/lib/run-push-audits.test.mjs). Stub it to a pass here:
  # the real one cd's to the repo root and runs the whole audit suite against a
  # fixture that deliberately has none of the repo it expects, which aborts the
  # script long before the content-survival check this test exists to exercise.
  printf '#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nexit 0\n' \
    > "$d/main/scripts/lib/run-push-audits.sh"
  chmod +x "$d/main/scripts/lib/run-push-audits.sh"

  # target.txt is a MODIFICATION-only file: it exists on main before our branch
  # touches it, which is the exact class the existence check cannot see.
  printf 'original line\n' > "$d/main/target.txt"
  git -C "$d/main" add -A
  git -C "$d/main" commit -qm "base"
  git -C "$d/main" push -q origin main

  # Our worktree branch modifies (never adds) target.txt.
  git -C "$d/main" checkout -q -b feature
  printf 'THE FIX LINE\n' > "$d/main/target.txt"
  git -C "$d/main" commit -qam "fix: the line that keeps disappearing"
  git -C "$d/main" checkout -q main

  # Second clone = the concurrent session.
  git clone -q "$d/origin.git" "$d/other"
  git -C "$d/other" config user.email o@o.o
  git -C "$d/other" config user.name o
}

# Inject the revert: push a commit that restores target.txt to its pre-fix
# content, exactly as a bad 3-way merge resolution on a busy main would.
inject_revert() {
  local d="$TMP/$1"
  git -C "$d/other" fetch -q origin main
  git -C "$d/other" reset -q --hard origin/main
  printf 'original line\n' > "$d/other/target.txt"
  git -C "$d/other" commit -qam "concurrent: silently revert the fix"
  git -C "$d/other" push -q origin main
}

run_script() {
  local d="$TMP/$1"; shift
  (cd "$d/main" && env "$@" bash scripts/merge-worktree-to-main.sh feature) 2>&1
}

echo "── case 1: clean merge, no interference (must NOT false-positive) ──"
setup clean
OUT="$(run_script clean)"; RC=$?
if [ "$RC" = 0 ]; then ok "exit 0 on a clean merge"; else bad "expected exit 0, got $RC:"; echo "$OUT" | tail -20; fi
if echo "$OUT" | grep -q "content-survival check"; then
  ok "content-survival check actually ran (not silently skipped)"
else
  bad "content-survival check never ran — the test would be vacuous"; echo "$OUT" | tail -20
fi
LIVE="$(git -C "$TMP/clean/origin.git" show main:target.txt 2>/dev/null)"
[ "$LIVE" = "THE FIX LINE" ] && ok "origin really holds the fix" || bad "origin content wrong: '$LIVE'"

echo "── case 2: concurrent writer reverts our lines (must FAIL loudly) ──"
# NOT timing-dependent, despite looking like a race: git runs post-receive
# server-side and the client's `git push` does not return until the hook has
# finished, so the injected revert is guaranteed to be on origin BEFORE the
# merge script reaches its verify step. And if it ever were not, the
# non-vacuity assertions below fail loudly rather than passing quietly.
setup drop
# Hook the injection into the window between the script's push and its verify.
# GIT_SSH_COMMAND etc. aren't available here, so use the reference-transaction
# hook on the bare repo: it fires on our push, and pushes the revert right after.
write_revert_hook() {
  local case_name="$1" bare="$TMP/$1/origin.git"
  cat > "$bare/hooks/post-receive" <<HOOK
#!/usr/bin/env bash
# One-shot: revert the fix the instant the push lands, then disarm so the
# injected push itself doesn't re-trigger this hook. cwd is the bare repo.
[ -f "\$PWD/.armed" ] || exit 0
rm -f "\$PWD/.armed"
# git exports GIT_DIR/GIT_QUARANTINE_PATH/etc into hooks, all pointing at the
# BARE repo mid-receive. Left set, every git command below would operate on
# the bare repo instead of the concurrent-session clone and the injection
# would silently no-op (which is exactly how this test first failed).
unset \$(git rev-parse --local-env-vars) 2>/dev/null
cd "$TMP/$case_name/other" || exit 0
git fetch -q origin main || exit 0
git reset -q --hard origin/main
printf 'original line\n' > target.txt
git commit -qam "concurrent: silently revert the fix" || exit 0
git push -q origin main
HOOK
  chmod +x "$bare/hooks/post-receive"
  touch "$bare/.armed"
}
write_revert_hook drop

OUT="$(run_script drop)"; RC=$?
LIVE="$(git -C "$TMP/drop/origin.git" show main:target.txt 2>/dev/null)"
# Non-vacuous injection assertion: 'original line' alone is ALSO what origin
# holds if the script never pushed at all (that content is the setup commit).
# Require BOTH that our fix commit reached origin's history AND that the file
# no longer holds it — i.e. a genuine push-then-revert, not a failed push.
# Capture first, THEN grep. `git log | grep -q` would look right and be wrong
# here: grep -q closes the pipe on its first match, git dies of SIGPIPE (141),
# and `set -o pipefail` (line 25) hands back 141 for a pipeline that MATCHED.
ORIGIN_LOG="$(git -C "$TMP/drop/origin.git" log --oneline main 2>/dev/null)"
PUSHED_OK=0
case "$ORIGIN_LOG" in *"the line that keeps disappearing"*) PUSHED_OK=1 ;; esac
if [ "$PUSHED_OK" = 1 ] && [ "$LIVE" = "original line" ]; then
  ok "fault injected: our commit reached origin, then its content was reverted"
else
  bad "injection did not take (pushed=$PUSHED_OK, origin='$LIVE') — case 2 proves nothing"
fi
if [ "$RC" != 0 ]; then ok "script exited non-zero ($RC) on a reverted push"; else bad "script exited 0 while its content was reverted — THE BUG"; fi
if echo "$OUT" | grep -qi "revert"; then ok "failure message names the revert"; else bad "no revert wording in output:"; echo "$OUT" | tail -20; fi

echo "── case 3: kill switch (must let the same revert through) ──"
setup killsw
write_revert_hook killsw

OUT="$(run_script killsw PUSH_SKIP_CONTENT_SURVIVAL_CHECK=1)"; RC=$?
# Same non-vacuity guard as case 2: if the revert never landed, "exit 0" would
# prove nothing about the kill switch.
if [ "$(git -C "$TMP/killsw/origin.git" show main:target.txt 2>/dev/null)" = "original line" ]; then
  ok "fault injected under kill switch"
else
  bad "injection did not take — case 3 proves nothing"
fi
if [ "$RC" = 0 ]; then ok "kill switch suppresses the check (exit 0)"; else bad "kill switch did not suppress (exit $RC):"; echo "$OUT" | tail -20; fi
if echo "$OUT" | grep -q "content-survival check"; then bad "check ran despite kill switch"; else ok "check skipped under kill switch"; fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ] || exit 1
