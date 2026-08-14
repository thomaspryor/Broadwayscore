#!/usr/bin/env bash
# Integration test for task #1511 (Notion 3bc637c5416f8183aa89fecafdc5cbc6):
# "merge-worktree-to-main.sh retry-merge failure swallows git's actual error
# output" — the push-retry loop's `git merge origin/$DEFAULT_BRANCH --no-edit`
# (scripts/merge-worktree-to-main.sh, inside the `for attempt in 1 2 3 4 5`
# loop) redirected the merge command's own stderr/stdout to /dev/null before
# calling die("could not merge remote changes on retry") — zero information
# on WHY it failed (real conflict? dirty tree? something else?), unlike the
# syntax-floor and push-audits die() paths a few lines above it, which both
# capture and print their command's output.
#
# This forces a REAL conflict on the retry-merge path specifically (not the
# initial pre-push merge at the top of the script): a `git` shim on PATH
# intercepts the script's first `push origin <branch>` call and, before
# forwarding it to real git, sneaks a conflicting commit onto origin from a
# separate clone — so the real push is rejected (non-fast-forward) and the
# script's retry loop falls through to `git merge origin/$DEFAULT_BRANCH
# --no-edit`, which now conflicts on the same file the worktree branch
# touched. Asserts die() fires with git's own conflict text included, not the
# old bare "could not merge remote changes on retry".
#
# Run: bash scripts/lib/merge-worktree-to-main.retry-merge-error.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_SCRIPT="$SCRIPT_DIR/../merge-worktree-to-main.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }
REAL_GIT_BIN="$(command -v git)"

D="$TMP/case1"
mkdir -p "$D"
git init -q --bare "$D/origin.git"
git init -q "$D/repo"
REPO="$D/repo"
gitc "$REPO" config user.email t@t; gitc "$REPO" config user.name t
gitc "$REPO" branch -M main

# Common ancestor: conflict.txt exists before either side diverges.
echo "base-version" > "$REPO/conflict.txt"
mkdir -p "$REPO/scripts/lib"
# No-op push-audits stub — this temp repo isn't the real scripts/lib/, and the
# script's push-audits step runs a real (relative-path) scripts/lib/run-push-audits.sh.
printf '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n' > "$REPO/scripts/lib/run-push-audits.sh"
chmod +x "$REPO/scripts/lib/run-push-audits.sh"
gitc "$REPO" add -A; gitc "$REPO" commit -q -m base
gitc "$REPO" remote add origin "$D/origin.git"
gitc "$REPO" push -q origin main

# feature-branch: the worktree branch under integration — modifies conflict.txt.
gitc "$REPO" checkout -q -b feature-branch
echo "feature-content" > "$REPO/conflict.txt"
gitc "$REPO" add -A; gitc "$REPO" commit -q -m "feature commit: real fix"
gitc "$REPO" push -q origin feature-branch
gitc "$REPO" checkout -q main

# A separate clone the git-shim uses to sneak a conflicting commit onto origin
# right as the script attempts its first push — simulating a concurrent
# session's push landing between this script's initial merge and its retry.
SNEAKY_CLONE="$D/sneaky-clone"
"$REAL_GIT_BIN" clone -q "$D/origin.git" "$SNEAKY_CLONE"
gitc "$SNEAKY_CLONE" config user.email s@s; gitc "$SNEAKY_CLONE" config user.name s

# git shim: forwards everything to the real git, except the FIRST
# `push origin <branch>` call, which first commits a conflicting change to
# conflict.txt from the sneaky clone (causing the real push to be rejected as
# non-fast-forward) before forwarding the real push.
WRAPPER_DIR="$D/wrapper"
mkdir -p "$WRAPPER_DIR"
MARKER="$D/sneaky-pushed.marker"
cat > "$WRAPPER_DIR/git" <<EOF
#!/usr/bin/env bash
REAL_GIT="$REAL_GIT_BIN"
SNEAKY_CLONE="$SNEAKY_CLONE"
MARKER="$MARKER"
args=("\$@")
if [ "\${args[0]:-}" = "-C" ]; then
  rest=("\${args[@]:2}")
else
  rest=("\${args[@]}")
fi
if [ "\${rest[0]:-}" = "push" ] && [ "\${rest[1]:-}" = "origin" ] && [ ! -f "\$MARKER" ]; then
  touch "\$MARKER"
  "\$REAL_GIT" -C "\$SNEAKY_CLONE" fetch origin -q
  "\$REAL_GIT" -C "\$SNEAKY_CLONE" reset -q --hard "origin/\${rest[2]:-main}"
  echo "sneaky-conflict-content" > "\$SNEAKY_CLONE/conflict.txt"
  "\$REAL_GIT" -C "\$SNEAKY_CLONE" add -A
  "\$REAL_GIT" -C "\$SNEAKY_CLONE" commit -q -m "sneaky concurrent commit conflicting with feature-branch"
  "\$REAL_GIT" -C "\$SNEAKY_CLONE" push -q origin "\${rest[2]:-main}"
fi
exec "\$REAL_GIT" "\${args[@]}"
EOF
chmod +x "$WRAPPER_DIR/git"

out=$(cd "$REPO" && PATH="$WRAPPER_DIR:$PATH" bash "$MERGE_SCRIPT" feature-branch 2>&1); code=$?

echo "--- script output ---"
echo "$out" | tail -40 | sed 's/^/    /'

if [ "$code" -eq 0 ]; then
  echo "FAIL: script exited 0 despite a genuine retry-merge conflict"
  fail=1
elif ! echo "$out" | grep -q "could not merge remote changes on retry"; then
  echo "FAIL: exited non-zero but NOT via the retry-merge die() message — this case didn't exercise what it claims to."
  fail=1
elif ! echo "$out" | grep -qE "CONFLICT|Automatic merge failed|conflict.txt"; then
  echo "FAIL: die() message did not include git's own conflict text (the bug this test guards against — output was suppressed)."
  fail=1
else
  echo "PASS: retry-merge conflict — script exited non-zero (got $code) via 'could not merge remote changes on retry', and the die() message includes git's own conflict output."
fi

if [ "$fail" -ne 0 ]; then echo "=== merge-worktree-to-main.retry-merge-error.test.sh FAILED ==="; exit 1; fi
echo "=== merge-worktree-to-main.retry-merge-error.test.sh PASSED ==="
