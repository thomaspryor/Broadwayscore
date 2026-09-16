#!/usr/bin/env bash
# Integration test for the BRO-3662 pre-flight-rebase-refusal diagnosis in
# push-with-retry.sh.
#
# The bug: `git rebase` refuses OUTRIGHT, before it starts, when the worktree or
# index is dirty ("cannot rebase: You have unstaged changes"). The old call site
# threw that stderr away with 2>/dev/null, so the helper announced "Rebase had
# conflicts", ran its 4-round resolve loop against ZERO conflicted files, and
# dropped to `git merge -X ours` — the path that resolves conflicting hunks in
# OUR favour and can silently discard a concurrent writer's changes.
#
# Seen live on process-feedback.yml run 34852355418: all 10 push retries logged
#     Rebase had conflicts, attempting auto-resolution...
#     Rebase could not be completed, aborting...
#     Trying merge fallback...
#   Already up to date.
#     Merge succeeded
# with nothing between the first two lines — i.e. diff-filter=U was empty — and
# a merge that reported "Already up to date", proving origin was already an
# ancestor and a rebase onto it should have been a clean no-op.
#
# Case 1 reproduces that exact shape and asserts the FIXED script names the real
# refusal instead of inventing a conflict. Case 2 is the guard against
# over-firing: a genuine conflict must still take the old path.
#
# Run: bash scripts/lib/push-with-retry.rebase-refusal.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── Case 1: dirty UNRELATED tracked file, origin already an ancestor ─────────
# Setup: origin has one commit; the clone adds a local commit on top (so a push
# is attempted and the retry loop is entered) and dirties a DIFFERENT tracked
# file. The remote is then advanced so the first push is rejected and the
# fetch+rebase path actually runs.
git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/seed"
printf 'base\n' > "$TMP/seed/tracked.txt"
printf 'other\n' > "$TMP/seed/other.txt"
git -C "$TMP/seed" add -A
git -C "$TMP/seed" commit -q -m base
git -C "$TMP/seed" push -q origin HEAD:main

git clone -q "$TMP/origin.git" "$TMP/work"
git -C "$TMP/work" checkout -q -B main origin/main

# Advance origin from a second clone so our push is rejected (remote ahead).
git clone -q "$TMP/origin.git" "$TMP/racer"
git -C "$TMP/racer" checkout -q -B main origin/main
printf 'remote-advance\n' >> "$TMP/racer/tracked.txt"
git -C "$TMP/racer" commit -q -am remote-advance
git -C "$TMP/racer" push -q origin main

# Our own commit to push...
printf 'local\n' >> "$TMP/work/local.txt"
git -C "$TMP/work" add local.txt
git -C "$TMP/work" commit -q -m local
# ...plus the dirty tracked file that makes rebase refuse pre-flight.
printf 'dirty\n' >> "$TMP/work/other.txt"

out1=$( cd "$TMP/work" && bash "$PUSH_SCRIPT" 2 main 2>&1 )

if ! grep -q "rebase REFUSED before it started" <<<"$out1"; then
  echo "FAIL[1]: expected the pre-flight-refusal warning. Output:"; echo "$out1"; fail=1
elif ! grep -qiE "unstaged changes|uncommitted changes|cannot rebase" <<<"$out1"; then
  echo "FAIL[1]: warning fired but the REAL git error was not surfaced. Output:"; echo "$out1"; fail=1
elif grep -q "Rebase had conflicts" <<<"$out1"; then
  echo "FAIL[1]: still mislabels a pre-flight refusal as a conflict. Output:"; echo "$out1"; fail=1
elif ! grep -q "dirty tracked paths:.*other.txt" <<<"$out1"; then
  echo "FAIL[1]: did not name the dirty tracked path that caused the refusal. Output:"; echo "$out1"; fail=1
else
  echo "PASS[1]: pre-flight refusal diagnosed, real git error shown, dirty path named"
fi

# ── Case 2: a GENUINE conflict must still take the conflict path ─────────────
# Guard against the new branch over-firing. The worktree is CLEAN, so the rebase
# really starts — and the conflict is MODIFY/DELETE, which `-X theirs` cannot
# auto-resolve. (Two competing one-line edits would NOT work here: `-X theirs`
# resolves those silently and the rebase would succeed, so the test would prove
# nothing about the conflict path — ship-check/Codex finding.)
git init -q --bare "$TMP/origin2.git"
git clone -q "$TMP/origin2.git" "$TMP/seed2"
printf 'line\n' > "$TMP/seed2/conflict.txt"
printf 'anchor\n' > "$TMP/seed2/anchor.txt"
git -C "$TMP/seed2" add -A
git -C "$TMP/seed2" commit -q -m base
git -C "$TMP/seed2" push -q origin HEAD:main

git clone -q "$TMP/origin2.git" "$TMP/work2"
git -C "$TMP/work2" checkout -q -B main origin/main

# Remote MODIFIES the file...
git clone -q "$TMP/origin2.git" "$TMP/racer2"
git -C "$TMP/racer2" checkout -q -B main origin/main
printf 'remote-side\n' > "$TMP/racer2/conflict.txt"
git -C "$TMP/racer2" commit -q -am remote-side
git -C "$TMP/racer2" push -q origin main

# ...while we DELETE it. -X theirs has no side to prefer for a modify/delete.
git -C "$TMP/work2" rm -q conflict.txt
git -C "$TMP/work2" commit -q -m local-deletes-it
# Worktree is CLEAN here — no dirty file.

out2=$( cd "$TMP/work2" && bash "$PUSH_SCRIPT" 2 main 2>&1 )

if grep -q "rebase REFUSED before it started" <<<"$out2"; then
  echo "FAIL[2]: pre-flight-refusal branch fired on a CLEAN worktree with a REAL conflict. Output:"; echo "$out2"; fail=1
elif ! grep -q "Rebase had conflicts" <<<"$out2"; then
  # Asserting the POSITIVE (conflict handling was entered) matters: checking
  # only that the refusal message is absent would also pass if the run died
  # early for some unrelated reason.
  echo "FAIL[2]: expected to ENTER conflict handling; never saw 'Rebase had conflicts'. Output:"; echo "$out2"; fail=1
else
  echo "PASS[2]: real conflict entered the conflict path, refusal branch stayed silent"
fi

exit $fail
