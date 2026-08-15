#!/usr/bin/env bash
# Integration test for Notion card 3b0637c5416f819fb6f8d4565acc7760 (task #819):
# "merge-worktree-to-main.sh exits 0 after 'could not checkout main'
# (stash-then-abort, silent failure)".
#
# Empirical investigation (bash -x trace on both bash 3.2 /bin/bash and the
# Homebrew bash 5.3 the shebang resolves to) found the die() path at
# scripts/merge-worktree-to-main.sh:117 already terminates the process via a
# real `exit 1` — the EXIT trap's push_mutex_release afterward does not
# override that status (bash preserves the exit code from an explicit `exit N`
# through a subsequent EXIT trap unless the trap itself calls `exit` again,
# which it doesn't). No live repro of the described 0-exit was found on the
# current script. This test locks that in as a permanent regression guard —
# the failure mode this file's own extensive incident history (#546/#668/
# #677/#686/#750) keeps producing is exactly this class: a silent-success
# bug that only a fault-injected integration test catches, because unit tests
# on the pure logic can't see bash's own control-flow semantics.
#
# Two scenarios, matching the card's own VERIFY wording:
#   1. "stash-then-abort": a dirty TRACKED file gets stashed successfully,
#      then checkout main still fails (blocked by an untracked file that
#      would be overwritten) — proves die() fires AFTER a successful stash,
#      not just when there was nothing to stash.
#   2. "UU-conflict simulation": an unresolved merge conflict (git status
#      shows UU) — proves die() fires when even `git stash push` itself
#      cannot succeed (mid-conflict stash is refused by git), so the script
#      must reach die() via the plain untracked/dirty-index path instead.
#      UPDATED (BRO-142): this repo left MERGE_HEAD present before the
#      script ever runs, which scripts/lib/detect-stale-merge-head.sh now
#      catches at the very top of merge-worktree-to-main.sh — earlier, and
#      with a clearer diagnosis ("existing MERGE_HEAD ... not created by
#      this run"), than the original checkout-main failure this case used to
#      reach. That's a strict improvement (same non-zero exit, no silent
#      success, no stash leaked, but a faster and more accurate refusal), so
#      the assertion below matches the new message instead of the old one.
#

# Run: bash scripts/lib/merge-worktree-to-main.checkout-fail.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_SCRIPT="$SCRIPT_DIR/../merge-worktree-to-main.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

setup_repo() {
  # $1 = repo dir. Bare origin + a clone with a mergeable feature-branch, so
  # the script's early "does $BRANCH exist" check (line 54) passes and we
  # reach the checkout-main logic that's actually under test.
  local dir="$1"
  git init -q --bare "$dir/origin.git"
  git init -q "$dir/repo"
  gitc "$dir/repo" config user.email t@t; gitc "$dir/repo" config user.name t
  gitc "$dir/repo" branch -M main
  echo base > "$dir/repo/tracked.txt"
  gitc "$dir/repo" add -A; gitc "$dir/repo" commit -q -m base
  gitc "$dir/repo" remote add origin "$dir/origin.git"
  gitc "$dir/repo" push -q origin main
  gitc "$dir/repo" checkout -q -b feature-branch
  echo feature > "$dir/repo/feature.txt"
  gitc "$dir/repo" add -A; gitc "$dir/repo" commit -q -m "feature commit"
  gitc "$dir/repo" push -q origin feature-branch
  gitc "$dir/repo" checkout -q main
}

# ── Case 1: dirty tracked file stashes cleanly, checkout main STILL fails ───
# (blocked by an untracked file collision) — the literal "stash-then-abort"
# shape named in the card title.
D1="$TMP/case1"
mkdir -p "$D1"
setup_repo "$D1"
REPO1="$D1/repo"

# A file that exists (tracked, different content) on main but is untracked
# on the current branch — checkout refuses rather than overwrite it.
gitc "$REPO1" checkout -q -b other main
gitc "$REPO1" rm -q --cached tracked.txt 2>/dev/null || true
gitc "$REPO1" commit -q -m "untrack tracked.txt on other"
echo "untracked-clash" > "$REPO1/tracked.txt"

# Add a SEPARATE dirty tracked file so `git stash push` has real work to do
# and reports success (STASHED=1 inside the script).
echo "extra tracked file" > "$REPO1/dirty.txt"
gitc "$REPO1" add "$REPO1/dirty.txt"
gitc "$REPO1" commit -q -m "add dirty.txt (tracked baseline)"
echo "dirtied" >> "$REPO1/dirty.txt"

pre_status1=$(gitc "$REPO1" status --porcelain)
out1=$(cd "$REPO1" && bash "$MERGE_SCRIPT" feature-branch 2>&1); code1=$?
post_stash1=$(gitc "$REPO1" stash list)
post_status1=$(gitc "$REPO1" status --porcelain)

if [ "$code1" -eq 0 ]; then
  echo "FAIL[1]: script exited 0 after a checkout-main failure (stash-then-abort silent-success bug is LIVE). Output:"
  echo "$out1" | tail -20 | sed 's/^/    /'
  fail=1
elif ! echo "$out1" | grep -q "could not checkout main"; then
  echo "FAIL[1]: expected the 'could not checkout main' message; got none. Output:"
  echo "$out1" | tail -20 | sed 's/^/    /'
  fail=1
elif [ -n "$post_stash1" ]; then
  echo "FAIL[1]: a stash entry was left behind after the abort (restore_stash() should have popped/dropped it): $post_stash1"
  fail=1
elif [ "$pre_status1" != "$post_status1" ]; then
  echo "FAIL[1]: working-tree status changed across the abort — the stashed dirty file was not cleanly restored."
  echo "  before: $pre_status1"
  echo "  after:  $post_status1"
  fail=1
else
  echo "PASS[1]: stash-then-abort — die() correctly exits non-zero (got $code1), no stash leaked, working tree restored"
fi

# ── Case 2: genuine UU merge conflict — the card's own "UU-conflict         ──
# simulation" wording. `git stash push` itself refuses mid-conflict, so this
# exercises the plain-dirty-index path into the same die() call.
D2="$TMP/case2"
mkdir -p "$D2"
setup_repo "$D2"
REPO2="$D2/repo"

# conflict.txt must exist in the common ancestor first — if both branches
# independently ADD it, git reports an add/add (AA) conflict, not the UU
# ("both modified") shape this scenario is named for.
echo "base-version" > "$REPO2/conflict.txt"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m "add conflict.txt (common ancestor)"
gitc "$REPO2" checkout -q -b other
echo "main-side" > "$REPO2/conflict.txt"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m "conflict.txt on other"
gitc "$REPO2" checkout -q main
echo "other-side" > "$REPO2/conflict.txt"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m "conflict.txt on main"
gitc "$REPO2" checkout -q other
gitc "$REPO2" merge main -q 2>/dev/null || true
if ! gitc "$REPO2" status --porcelain | grep -q '^UU'; then
  echo "FAIL[2]: setup did not produce a UU conflict — test assumptions broken, cannot exercise the scenario."
  fail=1
else
  pre_stash2=$(gitc "$REPO2" stash list)
  out2=$(cd "$REPO2" && bash "$MERGE_SCRIPT" feature-branch 2>&1); code2=$?
  post_stash2=$(gitc "$REPO2" stash list)

  if [ "$code2" -eq 0 ]; then
    echo "FAIL[2]: script exited 0 with an unresolved UU conflict in the working tree. Output:"
    echo "$out2" | tail -20 | sed 's/^/    /'
    fail=1
  elif ! echo "$out2" | grep -q "existing MERGE_HEAD in"; then
    # Non-zero alone isn't enough — an earlier, unrelated failure (mutex,
    # branch resolution, git incompatibility) would also exit non-zero and
    # falsely pass this case without ever exercising the intended path.
    # BRO-142: the pre-existing MERGE_HEAD guard now catches this before the
    # script ever reaches the checkout-main logic — see the header comment.
    echo "FAIL[2]: exited non-zero but NOT via the BRO-142 stale-MERGE_HEAD guard — this case didn't exercise what it claims to. Output:"
    echo "$out2" | tail -20 | sed 's/^/    /'
    fail=1
  elif [ "$pre_stash2" != "$post_stash2" ]; then
    echo "FAIL[2]: a new stash entry was created/left behind during the UU-conflict run."
    fail=1
  else
    echo "PASS[2]: UU-conflict simulation — script exits non-zero via the BRO-142 pre-existing-MERGE_HEAD guard (got $code2), no new stash entry"
  fi
fi

if [ "$fail" -ne 0 ]; then echo "=== merge-worktree-to-main.checkout-fail.test.sh FAILED ==="; exit 1; fi
echo "=== merge-worktree-to-main.checkout-fail.test.sh PASSED ==="
