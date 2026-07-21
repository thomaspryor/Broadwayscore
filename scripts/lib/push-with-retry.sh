#!/usr/bin/env bash
# Push to remote with retry and automatic conflict resolution for state files.
#
# Usage:
#   bash scripts/lib/push-with-retry.sh [max_retries] [branch]
#
# Defaults: 7 retries, main branch.
# Exits 0 on success, 1 on failure (all retries exhausted).
#
# Conflict resolution strategy:
#   1. Try git push (fast path, no conflict)
#   2. On failure: fetch remote, attempt rebase
#   3. If rebase has conflicts:
#      a. Modify/delete conflicts (e.g., --unknown renamed to --named-critic
#         on remote): accept the deletion — remote already has the better version
#      b. collection-state/ or audit/ files: keep local run's data
#      c. Other data files: accept remote version
#   4. If rebase still fails: abort and try merge with same auto-resolution
#   5. Retry with random jitter to avoid thundering herd
#
# Key insight: git swaps ours/theirs semantics between rebase and merge:
#   - Rebase: "ours" = remote base, "theirs" = our commits being replayed
#   - Merge:  "ours" = our branch,  "theirs" = remote being merged in
# This script handles both correctly.
#
# Before calling: git add + git commit must already be done.
# After calling: downstream if: always() steps still run on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MAX_RETRIES=${1:-7}
BRANCH=${2:-main}

# Pre-push conflict-marker guard (root-cause fix, 2026-06-29 / Notion 38e637c5).
# A bad enrich-reviews rebase once committed unresolved git conflict markers into a
# review-text JSON file (commit 09e78a7a), making it invalid JSON; the file was then
# silently dropped from reviews.json and reddened validate-review-texts on main. This
# guard scans the files about to be pushed — staged changes plus any commits ahead of
# the remote — for start-of-line conflict markers and ABORTS before the push if any
# are found. RUNS BEFORE EVERY push attempt in the retry loop (not just at startup),
# so a marker introduced by this script's own rebase/merge auto-resolution can't slip
# through on a later iteration. Detection lives in scripts/lib/conflict-markers.js
# (unit-tested): it matches the <<<<<<< opener / >>>>>>> closer, NOT the bare =======
# separator, so Markdown setext headings don't trip it. A literal 7+ "<"/">" run at
# line start is treated as a marker; for the rare legitimate case (a fixture/doc that
# embeds one on purpose) bypass with PUSH_SKIP_CONFLICT_CHECK=1.
assert_no_conflict_markers() {
  [ "${PUSH_SKIP_CONFLICT_CHECK:-}" = "1" ] && return 0
  command -v node >/dev/null 2>&1 || return 0  # detector needs node; skip if absent

  local files=""
  # Staged changes (added/copied/modified — skip deletions).
  files=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
  # Commits ahead of the remote tip (the corruption class: a marker that got
  # committed by a bad rebase and is now queued to push).
  if git rev-parse --verify --quiet "origin/$PULL_BRANCH" >/dev/null 2>&1; then
    local outgoing
    outgoing=$(git diff --name-only --diff-filter=ACM "origin/$PULL_BRANCH"..HEAD 2>/dev/null || true)
    files=$(printf '%s\n%s\n' "$files" "$outgoing")
  fi

  # Dedup + drop blanks, keep only files that still exist on disk.
  local existing=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    existing+=("$f")
  done < <(printf '%s\n' "$files" | sort -u)

  [ ${#existing[@]} -eq 0 ] && return 0

  if ! node "$SCRIPT_DIR/conflict-markers.js" "${existing[@]}"; then
    echo "::error::Refusing to push: one or more staged/outgoing files contain unresolved git conflict markers (see paths above). This is the corruption class that committed invalid JSON to review-texts (commit 09e78a7a). Resolve the markers, re-commit, then push. Bypass only if these are intentional fixture lines: PUSH_SKIP_CONFLICT_CHECK=1."
    exit 1
  fi
}

# Pre-push parentless-commit guard (root-cause fix, task #209 / Notion 3a2637c5).
# On 2026-07-19 the opening-night poller fast-path (which pushes through THIS
# helper) committed a PARENTLESS root commit (53ff06a4a7a) whose tree was a full
# repo snapshot, then a merge/rebase path here folded it into main via an
# unrelated-histories merge — leaving main with a SECOND repo root that doubled
# clone weight and corrupted per-file history. The shallow-checkout enabler is
# fixed at the source (fetch-depth: 0 on the poller), but this is the catch-all:
# NO commit ahead of the remote tip may be parentless, regardless of how HEAD
# got unborn. The true repo root is an ancestor of origin/$PULL_BRANCH and never
# appears in origin/$PULL_BRANCH..HEAD, so any parentless outgoing commit is a
# bug. RUNS BEFORE EVERY push attempt (like the conflict-marker guard) so a
# parentless commit produced by this script's own rebase/merge/reset resolution
# can't slip through on a later iteration. Detector: scripts/check-orphan-commits.js
# (unit-tested). Fail-open if the base ref or node is unavailable.
assert_no_orphan_commit() {
  command -v node >/dev/null 2>&1 || return 0  # detector needs node; skip if absent
  [ -f "$SCRIPT_DIR/../check-orphan-commits.js" ] || return 0
  git rev-parse --verify --quiet "origin/$PULL_BRANCH" >/dev/null 2>&1 || return 0

  if ! node "$SCRIPT_DIR/../check-orphan-commits.js" --range="origin/$PULL_BRANCH..HEAD"; then
    echo "::error::Refusing to push: an outgoing commit has NO parent (a second repo root). See task #209 — a shallow checkout feeding a rebase/merge/reset path produced a rootless full-tree commit. Do NOT push this; investigate how HEAD became unborn."
    exit 1
  fi
}

# BRANCH may be a refspec like "HEAD:main" (for push) or a plain branch
# name like "main". Pull commands need the remote branch name only.
if [[ "$BRANCH" == *:* ]]; then
  PULL_BRANCH="${BRANCH##*:}"
else
  PULL_BRANCH="$BRANCH"
fi

# (The conflict-marker guard is invoked at the top of each retry-loop iteration
# below, after PULL_BRANCH is known and after any in-loop rebase/merge resolution.)

# Check if a file has a modify/delete conflict.
# git checkout --ours/--theirs fails on these because one side has no version.
# Common cause: poller creates --unknown.json, LLM scoring renames it to
# --named-critic.json on remote — poller's push sees modify/delete.
# Returns 0 if modify/delete, 1 if normal conflict.
# Sets IS_DELETED_LOCALLY to "true" or "false".
is_modify_delete() {
  local file="$1"
  local mode="$2"
  IS_DELETED_LOCALLY=false

  # Check remote side
  if ! git cat-file -e "origin/$PULL_BRANCH:$file" 2>/dev/null; then
    # Remote deleted (or never had) this file — local modified
    return 0
  fi

  # Check local side (the commit being applied)
  if [ "$mode" = "rebase" ]; then
    # During rebase, REBASE_HEAD is the commit being replayed
    if ! git cat-file -e "REBASE_HEAD:$file" 2>/dev/null; then
      IS_DELETED_LOCALLY=true
      return 0
    fi
  else
    # During merge, MERGE_HEAD is the remote, HEAD is local
    if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
      IS_DELETED_LOCALLY=true
      return 0
    fi
  fi

  return 1  # Both sides have the file — normal conflict
}

# Auto-resolve conflicts by keeping our run's version of state files.
# Args: $1 = "rebase" or "merge" (determines ours/theirs mapping)
#
# During rebase: our commits = "theirs", remote base = "ours"
# During merge:  our branch = "ours",   remote = "theirs"
resolve_conflicts() {
  local mode="${1:-merge}"
  local resolved=false
  local conflicted_files
  conflicted_files=$(git diff --name-only --diff-filter=U 2>/dev/null || true)

  if [ -z "$conflicted_files" ]; then
    return 1  # No conflicts to resolve
  fi

  echo "  Conflicted files ($mode mode):"
  echo "$conflicted_files" | sed 's/^/    /'

  # Determine the correct flag to keep "our run's data" vs "remote's data"
  local keep_local keep_remote
  if [ "$mode" = "rebase" ]; then
    keep_local="--theirs"   # In rebase: theirs = our commits being replayed
    keep_remote="--ours"    # In rebase: ours = the remote base
  else
    keep_local="--ours"     # In merge: ours = our branch
    keep_remote="--theirs"  # In merge: theirs = remote being merged
  fi

  while IFS= read -r file; do
    # Handle modify/delete conflicts first — git checkout --ours/--theirs
    # fails when one side deleted the file (no version to checkout).
    # Common case: poller creates --unknown.json, LLM scoring renames to
    # --named-critic.json, so the --unknown file is deleted on remote.
    if is_modify_delete "$file" "$mode"; then
      if [ "$IS_DELETED_LOCALLY" = "true" ]; then
        # We deleted it, remote modified — keep remote's version
        echo "  Auto-resolving modify/delete (accept remote version): $file"
        git checkout $keep_remote "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
      else
        # Remote deleted (renamed), we modified — accept the deletion.
        # The renamed version already exists on remote with the correct data.
        echo "  Auto-resolving modify/delete (accept deletion): $file"
        git rm -f "$file" 2>/dev/null && resolved=true
      fi
      continue
    fi

    case "$file" in
      data/collection-state/*|data/audit/*)
        # State files: keep our run's version (each run writes independently)
        echo "  Auto-resolving (keep local): $file"
        git checkout $keep_local "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        ;;
      data/commercial.json|data/commercial-pending-review.json|data/commercial-research-queue.json)
        # Per-slug JSON merge so concurrent writers don't lose entries. The
        # "accept remote" default in this block previously silently dropped
        # local writes to commercial-pending-review.json — caught by ship-check
        # CDX-P0-1. mergeCommercialJson preserves humanReviewed* flags from the
        # loser side; mergePendingReview unions per-slug pending entries by
        # newest researchedAt. commercial-research-queue.json is written by 5
        # different cron workflows and previously fell to the generic
        # "accept remote" case below, silently dropping local queue additions
        # on conflict (plan-review finding, 2026-07-19) — mergeResearchQueue
        # unions both sides' slug arrays instead.
        echo "  Auto-resolving (per-slug merge): $file"
        if node "$SCRIPT_DIR/merge-commercial-conflict.js" "$file" "$keep_local" "$keep_remote" 2>&1; then
          git add "$file" 2>/dev/null && resolved=true
        else
          echo "  ::warning::Commercial merge failed for $file; falling back to keep-local"
          git checkout $keep_local "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        fi
        ;;
      *)
        # Other data files: accept remote (other workflows' changes)
        echo "  Auto-resolving (keep remote): $file"
        git checkout $keep_remote "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        ;;
    esac
  done <<< "$conflicted_files"

  if [ "$resolved" = "true" ]; then
    return 0
  fi
  return 1
}

# After rebase/merge, restore any manually-set correction fields
# (humanReviewScore, manualContentTier, etc.) that -X theirs silently dropped.
# These fields are ONLY set by humans, never by CI — always safe to restore.
restore_protected_fields() {
  if ! command -v node &>/dev/null; then return 0; fi
  local remote_ref="origin/$PULL_BRANCH"
  local count
  count=$(node "$SCRIPT_DIR/restore-protected-fields.js" "$remote_ref")
  if [ "$count" -gt 0 ] 2>/dev/null; then
    echo "  Restored protected fields in $count file(s) after rebase"
    git add -A
    git commit --amend --no-edit 2>/dev/null || true
  fi
}

pushed=false
for i in $(seq 1 "$MAX_RETRIES"); do
  # Re-scan before each attempt: catches both pre-existing committed markers (the
  # 09e78a7a corruption class) and any marker a prior iteration's rebase/merge
  # resolution might have left in the now-outgoing commits.
  assert_no_conflict_markers
  assert_no_orphan_commit
  if git push origin "$BRANCH"; then
    echo "Push succeeded on attempt $i"
    pushed=true
    break
  fi

  echo "Push failed (attempt $i/$MAX_RETRIES), fetching remote and rebasing..."
  git fetch origin "$PULL_BRANCH" 2>/dev/null || true

  # Capture pre-rebase HEAD so the post-rebase survival check (Sprint 5)
  # can diff against the commit we expect to preserve. Guards against
  # -X theirs auto-resolution silently discarding local additions.
  PRE_REBASE_SHA=$(git rev-parse HEAD)

  # Attempt 1: rebase with theirs strategy (= keep our commits' content)
  # In rebase context: "theirs" = our commits being replayed
  # history_changed: tracks whether ANY conflict-resolution path produced a
  # new HEAD this iteration. The post-rebase survival check fires on every
  # path that changed history, not just the happy rebase path — merge -X ours
  # and reset+cherry-pick are MORE likely to silently drop files than the
  # rebase path.
  rebase_ok=false
  history_changed=false
  # RESOLUTION_PATH records which strategy produced the new HEAD, so the
  # survival-check failure log pinpoints the exact path that dropped a file
  # (rebase-clean vs rebase-resolved vs merge vs cherry-pick). Diagnostics only.
  RESOLUTION_PATH=none
  if git rebase -X theirs "origin/$PULL_BRANCH" 2>/dev/null; then
    rebase_ok=true
    history_changed=true
    RESOLUTION_PATH="rebase-clean(-X theirs)"
    restore_protected_fields
  else
    echo "  Rebase had conflicts, attempting auto-resolution..."
    # Try up to 4 rounds of conflict resolution (one per conflicting commit)
    for _round in 1 2 3 4; do
      if resolve_conflicts rebase; then
        if GIT_EDITOR=true git rebase --continue 2>/dev/null; then
          rebase_ok=true
          history_changed=true
          RESOLUTION_PATH="rebase-resolved(${_round} round(s))"
          echo "  Rebase completed after $_round round(s) of conflict resolution"
          restore_protected_fields
          break
        fi
      else
        break  # No more conflicts to resolve but rebase still stuck
      fi
    done

    if [ "$rebase_ok" != "true" ]; then
      echo "  Rebase could not be completed, aborting..."
      git rebase --abort 2>/dev/null || true
    fi
  fi

  # Attempt 2: merge fallback (more robust for complex JSON conflicts)
  if [ "$rebase_ok" != "true" ]; then
    echo "  Trying merge fallback..."
    # -X ours in merge context = keep our branch's version
    if git merge "origin/$PULL_BRANCH" -X ours --no-edit 2>/dev/null; then
      echo "  Merge succeeded"
      history_changed=true
      RESOLUTION_PATH="merge(-X ours)"
      restore_protected_fields
    elif resolve_conflicts merge && git commit --no-edit 2>/dev/null; then
      echo "  Merge succeeded after auto-resolving conflicts"
      history_changed=true
      RESOLUTION_PATH="merge-resolved"
      restore_protected_fields
    else
      echo "  Merge also failed, aborting..."
      git merge --abort 2>/dev/null || true
      # Last resort: reset to remote, then cherry-pick our commit on top.
      # This guarantees we end up ahead of remote with our changes applied.
      echo "  Trying reset + cherry-pick approach..."
      OUR_HEAD=$(git rev-parse HEAD 2>/dev/null || true)
      if [ -n "$OUR_HEAD" ]; then
        git reset --hard "origin/$PULL_BRANCH" 2>/dev/null || true
        if git cherry-pick "$OUR_HEAD" --strategy-option=theirs 2>/dev/null; then
          echo "  Cherry-pick succeeded (our changes on top of remote)"
          history_changed=true
          RESOLUTION_PATH="reset+cherry-pick(-X theirs)"
          restore_protected_fields
        else
          git cherry-pick --abort 2>/dev/null || true
          git reset --hard "$OUR_HEAD" 2>/dev/null || true
          echo "  All conflict resolution strategies failed for this attempt"
        fi
      fi
    fi
  fi

  # Post-resolution survival check (Sprint 5 + Sprint 2.7 ship-check fix).
  # Fires on ANY path that changed history this iteration (rebase, merge
  # -X ours, reset+cherry-pick). The merge -X ours and cherry-pick paths
  # are MORE dangerous than rebase: they routinely drop local additions
  # when the strategy keeps the remote side of a conflict.
  if [ "$history_changed" = "true" ] && [ -n "${PRE_REBASE_SHA:-}" ] && [ -f "$SCRIPT_DIR/../check-post-rebase-survival.js" ]; then
    # check-post-rebase-survival requires beforeSha~1 to be an ancestor of
    # HEAD. Reset+cherry-pick may have broken that invariant — verify first.
    if git merge-base --is-ancestor "${PRE_REBASE_SHA}~1" HEAD 2>/dev/null; then
      if ! node "$SCRIPT_DIR/../check-post-rebase-survival.js" --before-sha="$PRE_REBASE_SHA" --remote-ref="origin/$PULL_BRANCH"; then
        echo "::error::Post-rebase survival check failed (resolution path: ${RESOLUTION_PATH:-unknown}) — aborting push to avoid shipping a corrupt state"
        echo "::error::See per-file diagnosis above: PRESENT-ON-REMOTE/RENAMED = likely legitimate concurrent change; ABSENT-EVERYWHERE = genuine loss."
        exit 1
      fi
    else
      echo "::warning::PRE_REBASE_SHA~1 is no longer an ancestor of HEAD (reset+cherry-pick likely ran); survival check skipped"
    fi
  fi

  # CROSS-SHOW OWNERSHIP GATE (2026-07-12, Notion 39b637c5-416f-8134): after a
  # resolution path brought remote history in, the tree finally reflects any
  # manual cross-show move that landed after this run checked out. Files our
  # commits ADD whose URL is live under another show are stale-checkout-race
  # re-creations (the tender poller incident pushed through THIS helper, not
  # the push-review-texts action) — git-rm + commit them before the next push
  # attempt. Review-texts repo only; fail-open (a validator crash must never
  # block a data push).
  if [ "$history_changed" = "true" ] && [ -f "$SCRIPT_DIR/../validate-added-review-ownership.js" ]; then
    _remote_url=$(git remote get-url origin 2>/dev/null || true)
    case "$_remote_url" in
      *broadway-review-texts*)
        node "$SCRIPT_DIR/../validate-added-review-ownership.js" --base="origin/$PULL_BRANCH" \
          || echo "::warning::validate-added-review-ownership crashed (non-blocking)"
        ;;
    esac
  fi

  # Backoff before retry. Shaped fast-then-growing instead of the old flat
  # 10-44s: pushes against the busy public main almost always succeed within
  # 2-3 attempts (a single bot commit landed between our fetch and push, so a
  # quick re-fetch+push slips in), so the early attempts must be cheap. The old
  # flat jitter spent ~27s avg per attempt — with up to 7 attempts and several
  # push calls per job, that alone pushed jobs (update-show-status, fetch-
  # todaytix, commercial-weekly) past their timeouts mid-push (2026-06-25→28,
  # 5+ days of daily cancellations). Now: attempt 1 ≈5-9s … attempt 7 ≈17-21s,
  # cutting typical (2-3 attempt) sleep time ~65% while keeping random jitter to
  # avoid thundering-herd clustering and longer backoff on persistent contention.
  WAIT=$(( 3 + i * 2 + RANDOM % 5 ))
  echo "  Waiting ${WAIT}s before retry..."
  sleep "$WAIT"
done

if [ "$pushed" != "true" ]; then
  echo "::error::All push attempts failed after $MAX_RETRIES attempts"
  exit 1
fi
