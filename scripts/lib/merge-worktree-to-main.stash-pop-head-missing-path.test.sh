#!/usr/bin/env bash
# Regression test for BRO-3595 (same bug class as BRO-2364's
# scripts/lib/sync-audit-checkout.sh fix): merge-worktree-to-main.sh's
# pop_stash_safely() auto-gen-only stash-pop-conflict resolver used to run
# `git checkout HEAD -- "$f"` unconditionally for every unmerged auto-gen
# path, swallowing the error with `|| true` when HEAD has no such path. That
# left the path unresolved in the index while `git stash drop` still ran —
# the content was gone with zero trace, no log line at all.
#
# EMPIRICAL NOTE on how "HEAD lacks this unmerged path" actually arises here
# (verified against real git, not assumed): a plain `git stash pop` refuses
# OUTRIGHT ("needs merge") the instant ANY unmerged index entry already
# exists — it never even attempts to apply the stash's own diff to a
# DIFFERENT, unrelated path. So a brand-new file that exists ONLY inside the
# stash (added via `git add`, never committed) can never itself become a
# newly-conflicted entry via stash-pop while a branch merge is already
# mid-conflict elsewhere — verified empirically: it just stays whatever the
# branch merge already left it as (typically a clean, non-conflicted `A`).
# The path this fix actually protects is a **modify/delete conflict**: the
# worktree branch MODIFIES an auto-gen path, local main independently
# DELETES it (e.g. a cleanup commit) — a completely ordinary, realistic
# divergence for daemon-managed state files. That produces a genuine `DU`
# unmerged entry where HEAD (main, the deleting side) has NO version of the
# path at all, which is exactly the shape `git cat-file -e HEAD:$f` must
# catch before calling `git checkout HEAD -- "$f"`.
#
# Scenario:
#   - data/audit/fileB.json: feature-branch modifies it; main DELETES it.
#     Merging feature-branch into main conflicts DU on this path (MERGE_HEAD
#     set), and HEAD never has a version of it once main's delete commit
#     lands — the exact "checkout HEAD -- <path> errors" trigger.
#   - data/audit/fileA.json: an unrelated tracked file, dirtied on main
#     before the script runs, so stash_if_dirty() has something real to
#     stash (STASHED=1) and pop_stash_safely() actually runs.
#
# Run: bash scripts/lib/merge-worktree-to-main.stash-pop-head-missing-path.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_SCRIPT="$SCRIPT_DIR/../merge-worktree-to-main.sh"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

D="$TMP/case1"
mkdir -p "$D"
git init -q --bare "$D/origin.git"
git init -q "$D/repo"
REPO="$D/repo"
gitc "$REPO" config user.email t@t; gitc "$REPO" config user.name t
gitc "$REPO" branch -M main

# Common ancestor: both auto-gen paths exist.
mkdir -p "$REPO/data/audit"
echo "fileA-base" > "$REPO/data/audit/fileA.json"
echo "fileB-base" > "$REPO/data/audit/fileB.json"
gitc "$REPO" add -A; gitc "$REPO" commit -q -m base
gitc "$REPO" remote add origin "$D/origin.git"
gitc "$REPO" push -q origin main

# feature-branch: modifies fileB (a normal daemon-style content update).
gitc "$REPO" checkout -q -b feature-branch
echo "branch-modified" > "$REPO/data/audit/fileB.json"
gitc "$REPO" add -A; gitc "$REPO" commit -q -m "feature commit: modify fileB"
gitc "$REPO" push -q origin feature-branch
gitc "$REPO" checkout -q main

# main: DELETES fileB (e.g. a cleanup/rotation commit) — HEAD will have NO
# version of this path once this lands, which is the trigger this test pins.
gitc "$REPO" rm -q data/audit/fileB.json
gitc "$REPO" commit -q -m "main: delete fileB"
gitc "$REPO" push -q origin main

# Dirty working-tree edit to an UNRELATED tracked file — this is what
# stash_if_dirty() stashes so pop_stash_safely() actually runs.
echo "dirtied" >> "$REPO/data/audit/fileA.json"
gitc "$REPO" add "$REPO/data/audit/fileA.json"

out=$(cd "$REPO" && bash "$MERGE_SCRIPT" feature-branch 2>&1); code=$?
status=$(gitc "$REPO" status --porcelain 2>/dev/null)
stash=$(gitc "$REPO" stash list 2>/dev/null)
fileB_exists="no"; [ -e "$REPO/data/audit/fileB.json" ] && fileB_exists="yes"

echo "--- script output ---"
echo "$out" | tail -40 | sed 's/^/    /'
echo "--- final git status ---"
echo "$status" | sed 's/^/    /'
echo "--- fileB.json exists: $fileB_exists ---"
echo "--- stash list: $stash ---"

if [ "$code" -eq 0 ]; then
  echo "FAIL: script exited 0 — a genuine modify/delete conflict on fileB.json should force a non-zero exit via merge_or_die/die()."
  fail=1
elif ! echo "$out" | grep -q "CONFLICT (modify/delete)"; then
  # Non-zero alone isn't enough — an earlier, unrelated failure would also
  # exit non-zero without exercising the DU-conflict path this test targets.
  echo "FAIL: exited non-zero but not via the expected modify/delete conflict on fileB.json — this case didn't exercise what it claims to."
  fail=1
elif echo "$status" | grep -qE '^(UU|AA|DU|UD|AU|UA) '; then
  echo "FAIL: an unmerged (conflicted) index entry remains after pop_stash_safely ran — the HEAD-missing-path case was not resolved (this is the BRO-3595 bug: the checkout-HEAD failure was swallowed, leaving the path unresolved while the stash was still dropped):"
  echo "$status" | sed 's/^/    /'
  fail=1
elif [ "$fileB_exists" = "yes" ]; then
  echo "FAIL: fileB.json (HEAD has NO version of it — main deleted it) should have been removed by the unstage+rm fallback, but it still exists in the working tree."
  fail=1
elif [ -n "$stash" ]; then
  echo "FAIL: a stash entry was left behind — pop_stash_safely should have dropped it once the auto-gen path was resolved."
  fail=1
else
  echo "PASS: modify/delete conflict on an auto-gen path (HEAD has no version) was cleanly unstaged and removed, no unresolved index entries remain, stash dropped."
fi

if [ "$fail" -ne 0 ]; then echo "=== merge-worktree-to-main.stash-pop-head-missing-path.test.sh FAILED ==="; exit 1; fi
echo "=== merge-worktree-to-main.stash-pop-head-missing-path.test.sh PASSED ==="
