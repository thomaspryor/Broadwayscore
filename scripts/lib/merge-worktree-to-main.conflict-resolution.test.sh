#!/usr/bin/env bash
# Integration test for task #888 (Notion 3b1637c5416f81cbbaffc2e8985cd515):
# "merge-worktree-to-main.sh's stash-pop-conflict auto-resolution silently
# takes the wrong side on a real merge conflict."
#
# Incident: `git merge $BRANCH` conflicts on a file the branch genuinely
# changed. restore_stash()'s fallback then runs `git stash pop`, which also
# conflicts (the working tree is already mid-merge-conflict on that same
# path) — and the OLD fallback logic responded by blindly
# `git checkout HEAD -- .`, silently overwriting the real merge conflict
# with main's stale pre-merge content while the script's own error message
# ("resolve manually") implied nothing had been touched yet. A caller that
# ran `git commit --no-edit` off that state would land the WRONG content
# while everything reported success.
#
# The fix distinguishes the two cases via MERGE_HEAD (a real branch-merge
# conflict is in progress) rather than a static "known auto-gen paths"
# allowlist — this repo's local daemon churns far more paths than the
# original 3-path list assumed (e.g. public/data/shows/ is
# `merge-coverage=exempt` in .gitattributes and among the highest-churn dirs
# in the repo), so a narrow allowlist would make ORDINARY daemon churn wedge
# the shared main worktree for every session, trading the silent-wrong-
# content bug for a blocks-everyone-on-routine-churn bug.
#
# Two cases:
#   1. Genuine merge conflict (MERGE_HEAD set): main and the worktree branch
#      both modify the SAME normal (non-auto-gen) path, plus a dirty
#      working-tree edit to that same path gets stashed first. Asserts the
#      script exits non-zero, leaves the real conflict markers/stash intact,
#      and does NOT silently resolve to main's stale content.
#   2. Ordinary churn, no merge conflict (no MERGE_HEAD): the worktree branch
#      doesn't touch the churned file at all, but origin/main moved the file
#      to different content between stash-push and stash-pop (simulating a
#      concurrent session's push) — a genuine stash-pop conflict with NO
#      branch-merge conflict involved. Asserts the script does NOT wedge
#      (exits 0, merge lands) instead of falsely treating routine churn as a
#      protected merge conflict.
#
# Run: bash scripts/lib/merge-worktree-to-main.conflict-resolution.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_SCRIPT="$SCRIPT_DIR/../merge-worktree-to-main.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

# ── Case 1: genuine merge conflict — restore_stash() must NOT touch it ──────
D1="$TMP/case1"
mkdir -p "$D1"
git init -q --bare "$D1/origin.git"
git init -q "$D1/repo"
REPO1="$D1/repo"
gitc "$REPO1" config user.email t@t; gitc "$REPO1" config user.name t
gitc "$REPO1" branch -M main

# Common ancestor: conflict.txt = "base" (a normal scripts/ path, deliberately
# NOT under cloud-memory/, data/audit/, or public/data/admin/ — those are the
# only paths the fix is allowed to auto-resolve).
mkdir -p "$REPO1/scripts/lib"
echo "base" > "$REPO1/scripts/lib/conflict.txt"
gitc "$REPO1" add -A; gitc "$REPO1" commit -q -m base
gitc "$REPO1" remote add origin "$D1/origin.git"
gitc "$REPO1" push -q origin main

# The worktree branch: the REAL incoming fix.
gitc "$REPO1" checkout -q -b feature-branch
echo "branch-fix-content" > "$REPO1/scripts/lib/conflict.txt"
gitc "$REPO1" add -A; gitc "$REPO1" commit -q -m "feature commit: real fix"
gitc "$REPO1" push -q origin feature-branch
gitc "$REPO1" checkout -q main

# Main independently (and committedly) changes the SAME file — this is what
# makes `git merge feature-branch` genuinely conflict, not just the stash.
echo "main-old-content" > "$REPO1/scripts/lib/conflict.txt"
gitc "$REPO1" add -A; gitc "$REPO1" commit -q -m "main also changed conflict.txt"
gitc "$REPO1" push -q origin main

# Dirty working-tree edit to the SAME path (simulating daemon churn) that the
# script will stash before attempting the merge.
echo "dirty-daemon-churn" > "$REPO1/scripts/lib/conflict.txt"

out1=$(cd "$REPO1" && bash "$MERGE_SCRIPT" feature-branch 2>&1); code1=$?
final1=$(cat "$REPO1/scripts/lib/conflict.txt" 2>/dev/null || echo "<missing>")
status1=$(gitc "$REPO1" status --porcelain 2>/dev/null)
stash1=$(gitc "$REPO1" stash list 2>/dev/null)

echo "--- case 1 script output ---"
echo "$out1" | tail -30 | sed 's/^/    /'
echo "--- case 1 final conflict.txt content ---"
echo "    $final1"
echo "--- case 1 git status ---"
echo "$status1" | sed 's/^/    /'

if [ "$code1" -eq 0 ]; then
  echo "FAIL[1]: script exited 0 despite a genuine merge conflict on conflict.txt"
  fail=1
elif [ "$final1" = "main-old-content" ]; then
  echo "FAIL[1]: conflict.txt was silently resolved to main's STALE content ('main-old-content') — the branch's real fix was discarded exactly like the task #888 incident."
  fail=1
elif ! echo "$out1" | grep -q "merge of feature-branch failed"; then
  # Non-zero alone isn't enough — an earlier, unrelated failure would also
  # exit non-zero and falsely pass this case without exercising the path
  # under test (same rigor as the sibling checkout-fail test).
  echo "FAIL[1]: exited non-zero but NOT via the expected 'merge of feature-branch failed' message — this case didn't exercise what it claims to."
  fail=1
elif ! echo "$status1" | grep -q '^UU scripts/lib/conflict.txt'; then
  echo "FAIL[1]: expected conflict.txt to still show as an unresolved (UU) merge conflict — got: $status1"
  fail=1
elif [ -z "$stash1" ]; then
  echo "FAIL[1]: the stash was dropped even though the real merge conflict was left unresolved — daemon-churn content is unrecoverable now."
  fail=1
else
  echo "PASS[1]: genuine merge conflict — script exited non-zero (got $code1), conflict.txt still shows UU with real conflict markers (not main's stale content), stash preserved"
fi

# ── Case 2: ordinary churn conflict, NO merge conflict — must NOT wedge ─────
D2="$TMP/case2"
mkdir -p "$D2"
git init -q --bare "$D2/origin.git"
git init -q "$D2/repo"
REPO2="$D2/repo"
gitc "$REPO2" config user.email t@t; gitc "$REPO2" config user.name t
gitc "$REPO2" branch -M main

# A path OUTSIDE the old static safe-list (public/data/shows/ — not
# public/data/admin/) that this repo's data daemon churns constantly.
mkdir -p "$REPO2/public/data/shows"
echo "v1" > "$REPO2/public/data/shows/x.json"
# Stub out the push-audits runner the real script calls post-merge — this
# temp repo doesn't carry the real scripts/lib/, and Case 2 (unlike Case 1)
# reaches past the merge into that step. A no-op stub that reads-and-exits-0
# matches a clean repo's real audit outcome for a trivial unrelated file add.
mkdir -p "$REPO2/scripts/lib"
printf '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n' > "$REPO2/scripts/lib/run-push-audits.sh"
chmod +x "$REPO2/scripts/lib/run-push-audits.sh"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m base
gitc "$REPO2" remote add origin "$D2/origin.git"
gitc "$REPO2" push -q origin main

# The worktree branch: unrelated change, does NOT touch x.json — the merge of
# this branch into main will be clean.
gitc "$REPO2" checkout -q -b feature-branch
echo "unrelated" > "$REPO2/README-feature.txt"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m "feature commit: unrelated"
gitc "$REPO2" push -q origin feature-branch
gitc "$REPO2" checkout -q main

# Simulate a concurrent session pushing a DIFFERENT version of x.json to
# origin between this session's stash-push and stash-pop.
echo "v2-origin" > "$REPO2/public/data/shows/x.json"
gitc "$REPO2" add -A; gitc "$REPO2" commit -q -m "concurrent session changed x.json"
gitc "$REPO2" push -q origin main
gitc "$REPO2" reset -q --hard HEAD~1   # local main is back at v1, unaware of origin's move

# Dirty working-tree edit to x.json (simulating this session's own daemon
# churn) based on the OLD v1 content — this is what will fail to 3-way-merge
# cleanly against origin's v2-origin during stash-pop.
echo "v1-local-dirty" > "$REPO2/public/data/shows/x.json"

out2=$(cd "$REPO2" && bash "$MERGE_SCRIPT" feature-branch 2>&1); code2=$?
status2=$(gitc "$REPO2" status --porcelain 2>/dev/null)
merged2=$(gitc "$REPO2" log --oneline main 2>/dev/null | grep -c "feature commit: unrelated" || true)

echo "--- case 2 script output ---"
echo "$out2" | tail -30 | sed 's/^/    /'
echo "--- case 2 git status ---"
echo "$status2" | sed 's/^/    /'

if [ "$code2" -ne 0 ]; then
  echo "FAIL[2]: script exited non-zero ($code2) on ORDINARY churn with no real merge conflict — a narrow auto-gen-path allowlist would wedge the shared main worktree for every session on routine daemon churn (task #888 review finding). Output:"
  echo "$out2" | tail -20 | sed 's/^/    /'
  fail=1
elif [ "$merged2" -lt 1 ]; then
  echo "FAIL[2]: feature-branch's commit never landed on main despite a 0 exit — merge did not actually complete."
  fail=1
elif echo "$status2" | grep -qE '^(U|AA|DD)'; then
  # Untracked noise (e.g. data/audit/verify-merge-landed.log from the async
  # delayed-reverify the real script schedules) is expected and fine — only
  # an unresolved/unmerged entry indicates the stash conflict wasn't cleaned up.
  echo "FAIL[2]: unresolved/unmerged entries remain after a successful run — got: $status2"
  fail=1
else
  echo "PASS[2]: ordinary churn conflict with no real merge in progress — script did NOT wedge (exited 0), feature-branch landed, working tree clean"
fi

if [ "$fail" -ne 0 ]; then echo "=== merge-worktree-to-main.conflict-resolution.test.sh FAILED ==="; exit 1; fi
echo "=== merge-worktree-to-main.conflict-resolution.test.sh PASSED ==="
