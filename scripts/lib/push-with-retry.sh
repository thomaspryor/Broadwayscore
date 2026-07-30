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
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/push-mutex.sh"

MAX_RETRIES=${1:-7}
BRANCH=${2:-main}

# ── Hang guards (Notion 39d637c5 / task #183) ────────────────────────────────
# Under high commit churn on a busy main, a `git fetch`/`git push` can stall on an
# open-but-idle HTTP connection to the remote (git has NO default low-speed abort),
# so the retry loop — bounded only in its *sleeps*, not its git ops — could sit
# in_progress for 20-25+ min. The `Record pipeline success` step in test.yml hung
# exactly this way (8 consecutive Data Validation jobs, 2026-07-14), and the job
# has no timeout-minutes so it rode the 6h default. Three layers below bound the
# wall-clock regardless of remote behaviour:
#   1. GIT low-speed config on every network op → git self-aborts a stalled xfer.
#   2. A portable `timeout` wrapper → hard SIGTERM/SIGKILL if git ignores (1).
#   3. An overall loop deadline (checked between attempts) → never exceed budget.
# All fail-OPEN: a missing `timeout` binary (stock macOS dev boxes) or a slow-but-
# progressing transfer is never blocked — the guards only kill genuine stalls.
#
# PUSH_DEADLINE_SEC sizing (task #458, 2026-07-26): 240s bounds *stalls* fine,
# but under this repo's very high main-branch commit churn (many concurrent cron
# workflows writing to main every few minutes), a GENUINE (non-stalled) fetch→
# rebase-conflict→abort→merge-fallback cycle measured ~3 min of real computation
# on update-show-status.yml's push step (run 30186060030) — the per-op network
# timeouts don't cover this because the cost is local (rebase/merge + node
# conflict-resolution scripts across however many commits landed since our
# checkout), not a stalled transfer. At 240s the loop only fit ~1.3 such cycles
# before self-aborting, so "All push attempts failed after 7 attempts" was
# misleading — only ~2 real cycles ever ran.
#
# DO NOT raise this SHARED default — ~15 of the 100+ callers have 5-10 min job
# timeouts (e.g. check-cron-health.yml, daily-digest.yml, update-deploy-
# watermark.yml) and push only small audit files that resolve in well under 240s
# today; raising the shared ceiling would let a genuine high-churn conflict on
# THEM run long enough to be hard-killed by GitHub's job timeout instead of this
# script's own controlled exit — losing the failure telemetry (record_push_
# failure below) and any `if: always()` follow-up steps (ship-check finding on
# this task, Codex adversarial review). Callers that measurably need more real
# cycles (like update-show-status.yml's "Commit and push changes" step) should
# override via `PUSH_DEADLINE_SEC=600 bash scripts/lib/push-with-retry.sh` at
# their own call site, after confirming their OWN job-timeout headroom.
GIT_NET_TIMEOUT_SEC=${GIT_NET_TIMEOUT_SEC:-90}   # hard cap per fetch/push op
GIT_LOW_SPEED_TIME=${GIT_LOW_SPEED_TIME:-45}     # git aborts if <1KB/s this long
PUSH_DEADLINE_SEC=${PUSH_DEADLINE_SEC:-240}      # overall wall-clock budget (~4 min); override per-caller for measured high-churn cost

# coreutils `timeout` on Linux/CI, `gtimeout` on macOS+coreutils, else absent.
_TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
_timeout() {  # _timeout <secs> <cmd...> — fail-open (run directly) if no binary
  local secs="$1"; shift
  if [ -n "$_TIMEOUT_BIN" ]; then
    "$_TIMEOUT_BIN" -k 10 "$secs" "$@"
  else
    "$@"
  fi
}
# Network-op wrappers: hard timeout + git-native low-speed abort. The lowSpeed
# config is HTTP-only (no-op on SSH remotes); the timeout wraps ALL transports
# (intended — a hung SSH push should die too, and 90s is generous for a real one).
git_fetch() {
  # unbounded-fetch-ok: this is the transport WRAPPER, not a call site. Every
  # invocation passes its own depth bound through "$@" (FETCH_DEPTH_ARGS below,
  # computed by scripts/lib/shallow-fetch-args.js whenever the checkout is
  # shallow). scripts/audit-unbounded-fetch.js cannot see through "$@", so the
  # waiver lives here rather than as a fake flag on the git line.
  _timeout "$GIT_NET_TIMEOUT_SEC" \
    git -c "http.lowSpeedLimit=1000" -c "http.lowSpeedTime=${GIT_LOW_SPEED_TIME}" fetch "$@"
}
git_push() {
  _timeout "$GIT_NET_TIMEOUT_SEC" \
    git -c "http.lowSpeedLimit=1000" -c "http.lowSpeedTime=${GIT_LOW_SPEED_TIME}" push "$@"
}

# Best-effort failure telemetry (task #394). Appends a JSONL record when a push is
# abandoned — either the no-op-rebase abort or full retry exhaustion below — so
# repeated exhaustion is DETECTABLE instead of silent-forever. health-check.js
# surfaces data/audit/push-retry-failures.jsonl as the "Push-retry deadman" row.
# Fail-OPEN: a telemetry write must never break or block the push flow.
# NOTE on persistence: when the failed push is the ONLY write in a CI job, this
# local file dies with the runner before it can be committed. In that pure-CI-fail
# case the durable signal is the ::error:: annotation plus the fact that the
# explicit-destination fetch below prevents the no-op in the first place. The log
# reliably captures local runs and any job that lands a LATER successful push.
PUSH_FAILURE_LOG="${PUSH_FAILURE_LOG:-$SCRIPT_DIR/../../data/audit/push-retry-failures.jsonl}"
record_push_failure() {
  local reason="${1:-unknown}" attempt="${2:-0}"
  local ts remote
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
  remote=$(git remote get-url origin 2>/dev/null | sed -E 's#.*[/:]##; s#\.git$##' || echo unknown)
  mkdir -p "$(dirname "$PUSH_FAILURE_LOG")" 2>/dev/null || true
  printf '{"ts":"%s","branch":"%s","remote":"%s","reason":"%s","attempt":%s,"maxRetries":%s,"ci":%s}\n' \
    "$ts" "${PULL_BRANCH:-?}" "$remote" "$reason" "$attempt" "${MAX_RETRIES:-?}" \
    "$([ -n "${GITHUB_ACTIONS:-}" ] && echo true || echo false)" \
    >> "$PUSH_FAILURE_LOG" 2>/dev/null || true
}

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
    restore_head_if_moved "conflict-markers"
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
    restore_head_if_moved "orphan-commit"
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

# ── Local push mutex (task #556) ─────────────────────────────────────────────
# Serializes the ENTIRE fetch→rebase/merge→push flow below across concurrent
# Claude Code sessions sharing this machine's .git (main checkout + every
# worktree) — not just the final `git push` call. The races behind #208 (lost
# merge commit), #543 (dropped commits) and #546 (false-green verify) all
# happened DURING this window, not at the push line itself, so the lock is
# held for the whole retry loop and released via the EXIT trap below. Fails
# OPEN on timeout: the retry/ancestor-check/survival-check logic already in
# this script is the defense-in-depth backstop for a session that proceeds
# without the lock. See scripts/lib/push-mutex.sh. The release trap is
# registered immediately below (not after SCRIPT_ENTRY_HEAD/restore_head_if_
# moved) so there is no window, now or after a future edit, where an
# unguarded failing command between acquire and trap registration could leak
# the lock — restore_head_if_moved only needs to EXIST by the time the trap
# fires, not by the time it's registered (ship-check finding, task #556).
push_mutex_acquire
trap 'rc=$?; push_mutex_release; [ "$rc" -ne 0 ] && restore_head_if_moved "trap-nonzero-exit-$rc"; exit $rc' EXIT

# ── Preserve-HEAD guard (task #543) ──────────────────────────────────────────
# Captured ONCE, before this script performs ANY fetch/rebase/merge/reset, so
# every abort (`exit 1`) below can prove — or forcibly restore — that local
# refs were left exactly as this script found them. Incident: 2026-07-26, a
# run that ended in the #466 shallow-ancestry-unrecoverable abort left local
# main missing two committed-but-unpushed commits, discovered only because
# they happened to also exist on a feature branch. The exact mutation was
# never pinned down (every read of the abort path shows it touching only
# remote-tracking refs), so this is deliberate defense-in-depth: whatever
# moves HEAD — this script's own resolution paths, a stale restore-on-failure,
# or something else entirely — every exit path now re-checks and repairs it
# before handing control back, instead of leaving a silently-shortened main.
SCRIPT_ENTRY_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
# Merge-base with origin as of script start — the "pre-edit" point for the
# content-survival check below (task #619). Computed once; a shallow/unborn
# history yields empty and the check fails OPEN (see push-content-survival.js).
SCRIPT_ENTRY_BASE=""
if [ -n "$SCRIPT_ENTRY_HEAD" ] && git rev-parse --verify --quiet "origin/$PULL_BRANCH" >/dev/null 2>&1; then
  SCRIPT_ENTRY_BASE="$(git merge-base "$SCRIPT_ENTRY_HEAD" "origin/$PULL_BRANCH" 2>/dev/null || true)"
fi

# Call immediately before every `exit 1` in the retry loop below. If local
# HEAD no longer matches what it was when this script started, force it back
# and name the at-risk commit(s) loudly — an abort must be a true no-op on
# local refs, never a silent partial rewrite.
restore_head_if_moved() {
  local reason="${1:-unknown}"
  [ -n "$SCRIPT_ENTRY_HEAD" ] || return 0
  local current_head
  current_head="$(git rev-parse HEAD 2>/dev/null || true)"
  [ -n "$current_head" ] && [ "$current_head" != "$SCRIPT_ENTRY_HEAD" ] || return 0

  echo "::error::push-with-retry: local HEAD moved from $SCRIPT_ENTRY_HEAD to $current_head during this run (abort reason: $reason)."
  echo "::error::  Commit(s) unique to the current (about-to-be-discarded) HEAD:"
  git log --oneline "$SCRIPT_ENTRY_HEAD".."$current_head" 2>/dev/null | sed 's/^/    /' || true
  echo "::error::  Commit(s) being restored (this run's original local history):"
  git log --oneline "$SCRIPT_ENTRY_HEAD" -5 2>/dev/null | sed 's/^/    /' || true
  if git reset --hard "$SCRIPT_ENTRY_HEAD" 2>/dev/null; then
    echo "::error::push-with-retry: restored HEAD to $SCRIPT_ENTRY_HEAD before aborting — the commit(s) above are intact on local main again."
  else
    echo "::error::push-with-retry: FAILED to restore HEAD to $SCRIPT_ENTRY_HEAD — recover manually with: git reset --hard $SCRIPT_ENTRY_HEAD"
  fi
}

# Why the trap above (registered right after push_mutex_acquire, before this
# function even existed) needs restore_head_if_moved: an uncontrolled `set -e`
# exit (e.g. a non-`|| true`-guarded command failing right after a rebase/
# merge/cherry-pick has already moved HEAD, such as restore_protected_fields()'s
# `count=$(node ...)`) skips every explicit `restore_head_if_moved` call below
# — the script just dies mid-function with HEAD already moved and no repair
# ever runs. The EXIT trap fires on ALL exits, including these, so it closes
# the gap regardless of which line triggered it. Gated on non-zero exit status
# only: on a genuine successful push (exit 0), HEAD legitimately differs from
# SCRIPT_ENTRY_HEAD (the rebase/merge WAS supposed to move it and its result
# WAS just pushed) — resetting there would silently strand local main behind
# what was just pushed. Idempotent with the manual calls (restore_head_if_moved
# no-ops if HEAD already matches).

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
      data/diary-shows.json)
        # Array-of-shows merge so concurrent Mezzanine writers (import-mezzanine-
        # historical, resolve-unmatched-imports, refresh-mezzanine-catalog) don't
        # lose each other's newly-added shows. The generic "accept remote" case
        # below would drop this run's additions wholesale (card #176, same class
        # as commercial.json CDX-P0-1). mergeDiaryShows unions both sides by
        # mezzanineId; ours wins on shared keys.
        echo "  Auto-resolving (diary-shows merge): $file"
        if node "$SCRIPT_DIR/merge-commercial-conflict.js" "$file" "$keep_local" "$keep_remote" 2>&1; then
          git add "$file" 2>/dev/null && resolved=true
        else
          echo "  ::warning::diary-shows merge failed for $file; falling back to keep-local"
          git checkout $keep_local "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        fi
        ;;
      data/social-post-history.json)
        # Array-of-posts merge. social-post.yml uses a PER-RUN concurrency group
        # (not static — update-show-status.yml dispatches it per-show in a tight
        # loop, and a static group risks GitHub's 1-pending-queue limit dropping a
        # show's post), so concurrent pushes for different shows are expected and
        # need a real merge here rather than serialization. The generic "accept
        # remote" case below would silently drop one run's new post entry,
        # defeating generate-social-post.js's duplicate-post check on the next
        # run. mergeSocialPostHistory unions both sides by tweetId; ours wins on
        # shared keys. Card 3a5637c5-416f-812a.
        echo "  Auto-resolving (social-post-history merge): $file"
        if node "$SCRIPT_DIR/merge-commercial-conflict.js" "$file" "$keep_local" "$keep_remote" 2>&1; then
          git add "$file" 2>/dev/null && resolved=true
        else
          echo "  ::warning::social-post-history merge failed for $file; falling back to keep-local"
          git checkout $keep_local "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        fi
        ;;
      *)
        # Other data files: accept remote (other workflows' changes) — but
        # ONLY when doing so doesn't discard real content our own commit
        # introduced (task #619 P0). Confirmed via fault injection (a
        # type-change conflict, the one structural shape that survives -X
        # ours/theirs auto-resolution and reaches this arm): blindly
        # `checkout $keep_remote` here replaces the WHOLE file with the
        # remote/base side, with nothing downstream re-checking file
        # CONTENT — the post-rebase survival check only tracks ADDED files
        # (--diff-filter=A) and no-ops on a pure modification, and the
        # no-op-rebase guard only proves the remote tip became an ancestor
        # of HEAD, a different and insufficient direction. Compare what
        # we're about to accept against what OUR side actually has for this
        # file; if identical there's nothing to lose. If they differ, leave
        # this file's conflict UNRESOLVED instead of silently discarding
        # real content — the round loop / rebase --continue then fails for
        # THIS file and the caller cascades to the more careful fallbacks
        # (merge -X ours, then reset+cherry-pick, which replays our FULL
        # commit range with --strategy-option=theirs rather than
        # wholesale-accepting remote for one file). A second, independent
        # backstop for exactly this class now also runs post-push: see
        # verify_content_survived() / push-content-survival.js.
        local accept_ref our_ref accept_blob our_blob
        if [ "$mode" = "rebase" ]; then
          accept_ref="HEAD"; our_ref="REBASE_HEAD"
        else
          accept_ref="MERGE_HEAD"; our_ref="HEAD"
        fi
        # git rev-parse (blob OID), NOT `$(git show ...)` (ship-check/Codex
        # finding): command substitution strips ALL trailing newlines and
        # mangles binary/NUL content, so e.g. "x\n" and "x\n\n" would compare
        # equal even though they're genuinely different — silently accepting
        # remote's version was still "safe, identical" when it wasn't. Blob
        # OIDs are exact content identity, same as push-content-survival.js.
        accept_blob=$(git rev-parse --verify --quiet "$accept_ref:$file" 2>/dev/null || echo "__ABSENT__")
        our_blob=$(git rev-parse --verify --quiet "$our_ref:$file" 2>/dev/null || echo "__ABSENT__")
        if [ "$accept_blob" = "$our_blob" ]; then
          echo "  Auto-resolving (keep remote, content identical): $file"
          git checkout $keep_remote "$file" 2>/dev/null && git add "$file" 2>/dev/null && resolved=true
        else
          echo "  ::warning::Refusing to auto-accept remote for $file — our version differs from remote's and would be silently discarded (task #619). Leaving unresolved so a safer fallback (merge/cherry-pick) can integrate it instead."
        fi
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

# Post-rebase reconciliation of the union-merged JSON files (task #420,
# ship-check/Codex finding). resolve_conflicts() knows to per-slug UNION
# commercial-pending-review.json et al., but it ONLY runs when the rebase
# actually conflicts — and `git rebase -X theirs` resolves conflicting hunks in
# favour of our replayed commits WITHOUT reporting a conflict. Measured on a
# fixture editing two different slugs three lines apart: "Successfully rebased",
# no conflict, remote slug's edit silently gone, merger never invoked.
#
# This pass re-merges those files against the remote tip after history moved,
# using the same union functions. OPT-IN (PUSH_RECONCILE_MERGED_JSON=1): ~114
# workflows push through this helper and flipping their conflict semantics
# wholesale is not a safe side effect of one card, so the default is unchanged.
# Fail-OPEN like restore_protected_fields — a reconciliation error must never
# block an otherwise-good push.
reconcile_merged_json() {
  [ "${PUSH_RECONCILE_MERGED_JSON:-}" = "1" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$SCRIPT_DIR/reconcile-merged-json.js" ] || return 0
  # ONE invocation: stdout is one changed repo-relative path per line (empty =
  # nothing to do), stderr streams to the job log. Running it twice (once for
  # the log, once for the list) would report empty the second time — the
  # first pass has already written the merged files.
  local out
  out=$(node "$SCRIPT_DIR/reconcile-merged-json.js" "origin/$PULL_BRANCH") || return 0
  [ -n "$out" ] || return 0

  # `git add` exactly the reconciled paths — NEVER `-A` (task #574 ship-check/
  # Codex finding: a blanket -A would also sweep up any OTHER untracked file
  # sitting in the job's working tree at this point, e.g. update-show-
  # status.yml's discovery-blocked audit JSON, which is deliberately pushed
  # to the PRIVATE repo only via a separate `gh api` step and must never land
  # in this public amended commit).
  local changed_files=()
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && changed_files+=("$line")
  done <<< "$out"
  [ ${#changed_files[@]} -gt 0 ] || return 0

  echo "  Reconciled ${#changed_files[@]} union-merged JSON file(s) against origin/$PULL_BRANCH (task #420): ${changed_files[*]}"
  git add -- "${changed_files[@]}"
  git commit --amend --no-edit 2>/dev/null || true
}

# Post-push CONTENT-survival check (task #619 P0). See scripts/lib/
# push-content-survival.js for the full rationale: neither the post-rebase
# survival check (ADDED files only) nor the no-op-rebase ancestor check can
# detect a rebase/merge/cherry-pick that silently discards a MODIFIED file's
# content while still producing a genuinely pushable (and pushed) commit.
# Called right after every point below that believes a push just succeeded.
# Re-fetches (bounded, best-effort) so the check reads the TRUE current tip,
# not a possibly-stale local tracking ref. Fails OPEN on the fetch itself (a
# network hiccup here must not manufacture a failure on an otherwise-good
# push) — never fails open on the content comparison, since that IS the
# signal this guard exists to catch.
#
# KNOWN RESIDUAL GAP (ship-check/Codex finding): this fetches AFTER our own
# push, so a third workflow that pushes to $PULL_BRANCH in the window between
# our push and this fetch can advance the file to yet another state — neither
# our intended content NOR the pre-edit base — which classifyFileSurvival()
# reports as "ambiguous" (assumed to be a legitimate concurrent edit) rather
# than "reverted". This is a real, accepted limitation: closing it completely
# would need a repo-wide lock across every one of the ~130 CI callers, which
# is out of scope for this fix. What this guard DOES catch reliably — and
# what neither pre-existing guard caught at all — is the exact task #619
# signature: our own resolution silently reverting to the pre-edit base with
# no OTHER concurrent write in between (the reproduced incident).
verify_content_survived() {
  # Emergency kill switch (ship-check/Codex finding) — this check is new and
  # globally affects every one of the ~130 workflows that push through this
  # helper, unlike the opt-in PUSH_RECONCILE_MERGED_JSON below. Mirrors the
  # existing PUSH_SKIP_CONFLICT_CHECK convention (conflict-marker guard
  # above) so a false-positive storm can be disabled without a code revert.
  [ "${PUSH_SKIP_CONTENT_SURVIVAL_CHECK:-}" = "1" ] && return 0
  [ -n "$SCRIPT_ENTRY_BASE" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$SCRIPT_DIR/push-content-survival.js" ] || return 0
  # MUST use the explicit-destination refspec (task #394 root cause): a bare
  # `git fetch origin $PULL_BRANCH` does not advance refs/remotes/origin/
  # $PULL_BRANCH under a SHA-pinned checkout refspec (actions/checkout), which
  # would make this check read a STALE tracking ref and false-positive
  # "REVERTED" on a change that actually landed fine (caught by the existing
  # noop-rebase integration test when this check was first wired in — it
  # reproduces exactly that pinned-refspec condition).
  git_fetch origin "+refs/heads/$PULL_BRANCH:refs/remotes/origin/$PULL_BRANCH" >/dev/null 2>&1 \
    || git_fetch origin "$PULL_BRANCH" >/dev/null 2>&1 || true
  node "$SCRIPT_DIR/push-content-survival.js" \
    --before-sha="$SCRIPT_ENTRY_HEAD" \
    --base-sha="$SCRIPT_ENTRY_BASE" \
    --check-ref="origin/$PULL_BRANCH"
}

pushed=false
for i in $(seq 1 "$MAX_RETRIES"); do
  # Overall wall-clock deadline (hang guard, task #183). $SECONDS counts from this
  # script's start. If a prior attempt's git op stalled up to its per-op timeout,
  # bail out here rather than starting another expensive round — the job must reach
  # a conclusion even under heavy churn. Failing here takes the SAME path as normal
  # retry exhaustion (pushed=false → exit 1) — no new failure mode: callers that
  # tolerate a failed push (health steps: `|| echo ::warning::`) still warn, and
  # callers that fail hard on exit 1 now get a bounded red in ~4 min instead of the
  # 6h hang. A commit resolved just before the deadline is still pushed: the
  # in-iteration push after conflict resolution (below) publishes it before we can
  # break here.
  if [ "$SECONDS" -ge "$PUSH_DEADLINE_SEC" ]; then
    echo "::warning::push-with-retry: overall deadline ${PUSH_DEADLINE_SEC}s exceeded after $((i - 1)) attempt(s); giving up to avoid hanging the job"
    break
  fi

  # Re-scan before each attempt: catches both pre-existing committed markers (the
  # 09e78a7a corruption class) and any marker a prior iteration's rebase/merge
  # resolution might have left in the now-outgoing commits.
  assert_no_conflict_markers
  assert_no_orphan_commit
  if git_push origin "$BRANCH"; then
    if verify_content_survived; then
      echo "Push succeeded on attempt $i"
      pushed=true
      break
    else
      echo "::error::push-with-retry: push on attempt $i reported success but our own commit's content is NOT what's on origin/$PULL_BRANCH afterward (task #619) — a prior iteration's conflict resolution silently discarded it. Resetting local HEAD back to our original commit and retrying instead of reporting false success."
      record_push_failure "commit-dropped-post-push" "$i"
      git reset --hard "$SCRIPT_ENTRY_HEAD" 2>/dev/null || true
    fi
  fi

  echo "Push failed (attempt $i/$MAX_RETRIES), fetching remote and rebasing..."
  # Task #394 ROOT-CAUSE FIX: fetch with an EXPLICIT destination refspec so
  # refs/remotes/origin/$PULL_BRANCH is force-advanced to the true remote tip.
  # A bare `git fetch origin $PULL_BRANCH` only guarantees FETCH_HEAD; under
  # actions/checkout's SHA-pinned fetch refspec it leaves the tracking ref STALE,
  # so `git rebase -X theirs origin/$PULL_BRANCH` (and EVERY other consumer of
  # origin/$PULL_BRANCH below — is_modify_delete, restore_protected_fields, the
  # survival check, the merge/cherry-pick fallbacks) operates on a stale base: the
  # rebase reports "Current branch is up to date", integrates nothing, and the push
  # is rejected ("fetch first") for all 7 attempts while the `|| echo ::warning::`
  # call site swallows it — so the alert-ledger (or any state file) NEVER persists
  # from CI. An explicit ":refs/remotes/origin/X" destination ALWAYS updates the
  # tracking ref regardless of the configured refspec. Falls back to the bare form
  # if the explicit refspec is rejected (fail-open) — but NOT if it timed out (see
  # task #464 below): a fast rejection (bad refspec) is a different remote under a
  # different condition than a timeout, so retrying the bare form after a rejection
  # is still worth it.
  #
  # Task #464 ROOT-CAUSE FIX: the explicit-refspec fetch above and the bare-form
  # fallback were BOTH hitting the full GIT_NET_TIMEOUT_SEC=90 cap back-to-back
  # under high main-branch churn (measured: exact 180s gaps in 3 real CI runs,
  # 2026-07-25/26 — 'Update Shows', 'Audit Aggregator Review Gap', 'Process
  # Feedback Submissions'). The low-speed guard (http.lowSpeedLimit/Time, 45s)
  # never fired in these runs, which rules out a stalled/idle connection — a
  # genuinely stalled transfer aborts at 45s, well under the 90s hard cap. So the
  # fetch was actively transferring data the whole time and still didn't finish in
  # 90s: a real, not stalled, slow fetch. Retrying the SAME operation (same repo,
  # same remote, same network path, seconds later) under the SAME slow condition
  # has near-zero chance of finishing faster, so the fallback was burning a second
  # full 90s for nothing — the doubled-timeout that starved PUSH_DEADLINE_SEC (see
  # task #458 above) down to ~1.3 real retry cycles instead of several. Fix: only
  # fall back to the bare form when the explicit form failed FAST (e.g. refspec
  # rejected) — exit 124 from the `timeout` wrapper means it hit the wall, so skip
  # straight to the outer retry loop's backoff+next-iteration, which gets a FRESH
  # 90s budget instead of doubling down on a doomed retry. Per-fetch wall-clock is
  # now logged so a future incident is directly measurable, not inferred from gaps.
  # Task #466 ROOT-CAUSE FIX: depth-bound the fetch when the checkout is SHALLOW.
  # Task #464 read the identical ~90s walls as "a real but slow transfer" and
  # only stopped the SECOND one. The measurement it inferred rather than took
  # shows something worse: it is not slow, it is unbounded. ~100 of the 129
  # workflows that push through this helper run on an actions/checkout with the
  # DEFAULT `fetch-depth: 1` — a shallow clone holding ONE commit (only 26 set
  # fetch-depth: 0). A `git fetch` that carries no depth bound asks upload-pack
  # for the ref's history with no cut-off, and from a shallow client the server
  # answers with the ENTIRE repository: 165k+ commits, ~2.1 GB. Measured
  # 2026-07-26 from depth-1 clones 30 min behind live main, all four identical
  # except the flags:
  #     bare      `git fetch origin main`                        300s rc=124 (>1.4 GB pulled, still going)
  #     explicit  `+refs/heads/main:refs/remotes/origin/main`     300s rc=124
  #     explicit + --depth=1                                        8s rc=0
  # So the explicit-destination refspec was NEVER the variable — the incident
  # report's central hypothesis (task #466's title) is refuted. Bare and
  # explicit fail identically; the missing depth bound is the whole story. That
  # is also why run 30191044729 hit the SAME ~90-91s wall on all 7 attempts with
  # essentially zero variance: a fixed structural cost, not jitter. And why the
  # low-speed guard never fired — the transfer really was moving data the whole
  # time, just ~2.1 GB of it.
  #
  # WHY NOT JUST --depth=1 (the 8s winner above): it is fast and WRONG. It makes
  # the fetched tip a parentless shallow root, so our base commit stops being an
  # ancestor of origin/$PULL_BRANCH and every consumer below (rebase -X theirs,
  # the merge fallback, is_modify_delete, the survival check) operates on an
  # unrelated history — `git rebase` would replay the shallow root's whole-tree
  # snapshot as if it were our change, reverting whatever else landed on main.
  # A fast fetch that loses ancestry is worse than a slow one, so the decision
  # helper deliberately does NOT emit --depth=1. See scripts/lib/shallow-fetch-
  # args.js (unit-tested, §15) for the full rationale; it emits --shallow-since
  # anchored 30 min BEFORE our own boundary commit, which bounds the transfer to
  # the churn window we actually need AND keeps the boundary commit inside it,
  # so ancestry survives. Self-tuning: a job pushing 3 min after checkout pulls
  # 3 min of history; one pushing an hour later pulls an hour.
  #
  # Complete (fetch-depth: 0) checkouts get NO extra flags — bounding them would
  # TRUNCATE a full clone into a shallow one and throw away history the job may
  # still need.
  FETCH_DEPTH_ARGS=()
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    # Oldest LOCAL commit = the shallow boundary (cheap: a shallow repo holds
    # only a handful of commits). This is the commit that must remain an
    # ancestor of the fetched tip.
    #
    # Computed ONCE for the whole run, not per iteration. This block sits inside
    # the retry loop and each successful bounded fetch DEEPENS the repo, so the
    # boundary moves further back in time every pass. Recomputing would subtract
    # another SHALLOW_SINCE_SLACK_SEC from an already-older boundary each time —
    # the window would creep wider (and the fetch slower) with every retry, for
    # no benefit: the original boundary is the commit our outgoing work is built
    # on, and any later boundary is older, so the first window already covers
    # what ancestry needs. Memoising also keeps the decision deterministic
    # across a run, which is what the ancestry assert below reasons about.
    #
    # `|| true` on the rev-list is load-bearing under `set -euo pipefail`: with
    # pipefail a failing `git rev-list` (unborn HEAD) makes the whole pipeline —
    # and therefore this assignment — non-zero, and `set -e` would abort the
    # entire push mid-retry. Falling through with an empty value is correct: the
    # helper then returns the bounded --depth fallback.
    if [ -z "${_shallow_base_sha:-}" ]; then
      _shallow_base_sha=$(git rev-list HEAD 2>/dev/null | tail -1 || true)
      _shallow_base_epoch=$(git log -1 --format=%ct "${_shallow_base_sha:-HEAD}" 2>/dev/null || echo "")
    fi
    if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/shallow-fetch-args.js" ]; then
      # None of the emitted args can contain whitespace (asserted in the test),
      # so unquoted word-splitting into the array is safe here.
      # shellcheck disable=SC2207
      FETCH_DEPTH_ARGS=($(node "$SCRIPT_DIR/shallow-fetch-args.js" \
        --is-shallow=true \
        --oldest-epoch="${_shallow_base_epoch:-}" \
        --slack-sec="${SHALLOW_SINCE_SLACK_SEC:-1800}" 2>/dev/null || true))
    fi
    # Fail CLOSED, not open: if node is missing or the helper crashed, an empty
    # array would silently restore the unbounded fetch this block exists to
    # prevent. A fixed depth is still bounded (and the ancestry check below
    # escalates if that depth doesn't reach our base).
    if [ ${#FETCH_DEPTH_ARGS[@]} -eq 0 ]; then
      FETCH_DEPTH_ARGS=(--deepen=200)
    fi
    echo "  fetch: SHALLOW checkout ($(git rev-list --count HEAD 2>/dev/null || echo '?') local commit(s)) — bounding with ${FETCH_DEPTH_ARGS[*]} (task #466)"
  fi
  # NOTE on the ${arr[@]+"${arr[@]}"} expansions below: bash 3.2 (stock
  # /usr/bin/bash on macOS) treats "${arr[@]}" on an EMPTY array as an unbound
  # variable under `set -u`, which would abort the script on every non-shallow
  # checkout. Same guard scripts/hooks/pre-push uses for PUSH_SPECS.
  fetch_ok=false
  fetch_start=$SECONDS
  if git_fetch ${FETCH_DEPTH_ARGS[@]+"${FETCH_DEPTH_ARGS[@]}"} origin "+refs/heads/$PULL_BRANCH:refs/remotes/origin/$PULL_BRANCH" 2>/dev/null; then
    fetch_ok=true
    echo "  fetch(explicit-refspec) OK in $((SECONDS - fetch_start))s"
  else
    explicit_fetch_rc=$?
    echo "  fetch(explicit-refspec) FAILED in $((SECONDS - fetch_start))s (rc=$explicit_fetch_rc)"
    if [ "$explicit_fetch_rc" -eq 124 ]; then
      echo "  Skipping bare-form fallback fetch: explicit form timed out (rc=124) — retrying the identical fetch under the same slow network condition would likely also burn the full ${GIT_NET_TIMEOUT_SEC}s for nothing (task #464). Backing off to next retry attempt instead."
    else
      # The explicit form failed FAST (not a timeout). When we passed a shallow
      # bound, the BOUND may be exactly what the remote rejected — e.g. git
      # answers `fatal: no commits selected for shallow requests` (rc≠124) if
      # committer-clock skew puts the since-window past every remote commit.
      # Re-issuing the identical flag on the bare form would fail identically,
      # so degrade to the fixed depth instead. Still bounded — never unbounded,
      # which is the whole point of this block (ship-check finding).
      _fallback_depth_args=()
      if [ ${#FETCH_DEPTH_ARGS[@]} -gt 0 ]; then
        _fallback_depth_args=(--deepen=200)
        echo "  Bare-form fallback degrades the bound ${FETCH_DEPTH_ARGS[*]} → --deepen=200 (the bound itself may be what was rejected)"
      fi
      fetch_start=$SECONDS
      if git_fetch ${_fallback_depth_args[@]+"${_fallback_depth_args[@]}"} origin "$PULL_BRANCH" 2>/dev/null; then
        fetch_ok=true
        echo "  fetch(bare-form fallback) OK in $((SECONDS - fetch_start))s"
      else
        echo "  fetch(bare-form fallback) FAILED in $((SECONDS - fetch_start))s (rc=$?)"
      fi
    fi
  fi

  # Ancestry escalation (task #466). A depth-bounded fetch is only correct if it
  # reached back far enough to keep our boundary commit an ancestor of the new
  # tip; otherwise every resolution path below sees an unrelated history and the
  # no-op guard further down aborts the whole push. --shallow-since anchored
  # before the boundary should always satisfy this (its window contains the
  # boundary by construction), so reaching here means either the --deepen=200
  # fallback ran and 200 commits didn't span the gap (this repo lands ~150
  # commits/hour, so ~80 min of headroom), or a committer-date skew pushed an
  # intermediate commit outside the window. Widen to a full day — still ~1% of
  # the 165k-commit history, and still bounded by the per-op timeout. One
  # escalation only: if it
  # still fails we treat the whole fetch as FAILED rather than spiralling.
  #
  # That last part is load-bearing, not tidiness (ship-check P0): if this block
  # merely warned and fell through, `fetch_ok` would still be true, so
  # FETCHED_REMOTE_SHA below would be read from a STALE FETCH_HEAD and the
  # update-ref would force refs/remotes/origin/$PULL_BRANCH onto a tip our base
  # is provably NOT an ancestor of — then `rebase -X theirs origin/$PULL_BRANCH`
  # replays against unrelated history. That is exactly the --depth=1 disaster
  # this design rejects. Setting fetch_ok=false routes us down the existing,
  # already-safe "fetch failed" path: no tracking-ref write, no no-op guard,
  # just backoff and retry with a fresh budget.
  if [ "$fetch_ok" = "true" ] && [ ${#FETCH_DEPTH_ARGS[@]} -gt 0 ] && [ -n "${_shallow_base_sha:-}" ]; then
    if ! git merge-base --is-ancestor "$_shallow_base_sha" FETCH_HEAD 2>/dev/null; then
      # Pick a widening that is actually REACHABLE on both paths. Gating this on
      # a non-empty epoch (as the first cut did) made it dead code precisely
      # when it mattered: the --depth fallback is chosen BECAUSE the epoch was
      # unusable, so the epoch-only escalation could never run for it
      # (ship-check P0). --deepen is relative, so it works with no date at all.
      if [ -n "${_shallow_base_epoch:-}" ]; then
        _widen_args=(--shallow-since="@$((_shallow_base_epoch - 86400))")
      else
        _widen_args=(--deepen=2000)
      fi
      echo "  ::warning::fetch was depth-bounded but base $_shallow_base_sha is NOT an ancestor of the fetched tip — widening with ${_widen_args[*]} and refetching (task #466)"
      fetch_start=$SECONDS
      if git_fetch "${_widen_args[@]}" \
           origin "+refs/heads/$PULL_BRANCH:refs/remotes/origin/$PULL_BRANCH" 2>/dev/null; then
        echo "  fetch(widened ${_widen_args[*]}) OK in $((SECONDS - fetch_start))s"
      else
        echo "  fetch(widened ${_widen_args[*]}) FAILED in $((SECONDS - fetch_start))s"
      fi
      # Re-assert on the (possibly refreshed) FETCH_HEAD. Note a widened fetch
      # that FAILS leaves the previous successful FETCH_HEAD in place, so this
      # re-check — not the fetch's exit status — is what decides.
      if ! git merge-base --is-ancestor "$_shallow_base_sha" FETCH_HEAD 2>/dev/null; then
        # ABORT — do not fall through, and do not merely retry.
        #
        # First cut set fetch_ok=false here, assuming that was enough to keep
        # the resolution paths away from unrelated history. Fault injection
        # (forcing the ancestry-breaking --depth=1 bound) proved it is NOT: the
        # explicit-destination refspec writes refs/remotes/origin/$PULL_BRANCH
        # as part of the fetch itself, so the tracking ref is ALREADY poisoned
        # before this check runs. fetch_ok only gates our own update-ref and the
        # no-op guard; `git rebase -X theirs origin/$PULL_BRANCH` below reads the
        # tracking ref directly and happily replayed the shallow-root snapshot
        # (observed: 2 commits ahead instead of 1). Backing off and retrying is
        # no better — the next iteration re-poisons the same ref.
        #
        # There is no safe local recovery: we cannot know a good tip, and every
        # onward path either corrupts main or burns the retry budget to reach
        # the same failure. So take the same exit the no-op guard takes — loud,
        # logged, non-zero — and leave main untouched. `if: always()` steps and
        # the failure telemetry still run.
        record_push_failure "shallow-ancestry-unrecoverable" "$i"
        echo "::error::push-with-retry: depth-bounded fetch could not restore ancestry — base $_shallow_base_sha is still NOT an ancestor of the fetched tip after widening with ${_widen_args[*]}. refs/remotes/origin/$PULL_BRANCH now points at a tip with unrelated history, so rebase/merge would replay this shallow checkout's whole-tree snapshot over whatever else landed on $PULL_BRANCH. Aborting instead (task #466). Re-run the job; if this repeats, the checkout needs fetch-depth: 0. Logged to data/audit/push-retry-failures.jsonl."
        restore_head_if_moved "shallow-ancestry-unrecoverable"
        exit 1
      fi
    fi
  fi
  # Authoritative remote tip for the post-resolution progress assertion below.
  # ONLY capture it when THIS iteration's fetch succeeded — otherwise FETCH_HEAD may
  # be a leftover from a prior iteration (ship-check #394 Codex finding), which could
  # make the guard reason about the wrong commit (false abort, or missed no-op) on a
  # transient network failure. Leaving it empty skips the guard so the loop simply
  # backs off and retries — the correct behaviour for a failed fetch. Prefer
  # FETCH_HEAD (always written by a successful fetch) over the tracking ref.
  FETCHED_REMOTE_SHA=""
  if [ "$fetch_ok" = "true" ]; then
    FETCHED_REMOTE_SHA=$(git rev-parse --verify --quiet FETCH_HEAD 2>/dev/null \
      || git rev-parse --verify --quiet "origin/$PULL_BRANCH" 2>/dev/null || echo "")
    # Belt-and-suspenders (ship-check #394 Codex residual): if the explicit-dest
    # fetch above was rejected and only the bare fallback ran, refs/remotes/origin/
    # $PULL_BRANCH may still be stale even though FETCH_HEAD is fresh — and the
    # resolution paths below all rebase/merge/reset against origin/$PULL_BRANCH.
    # Force the tracking ref onto the authoritative fetched tip so every path gets a
    # fresh base (not just a loud no-op abort). Local, fail-open.
    if [ -n "$FETCHED_REMOTE_SHA" ]; then
      git update-ref "refs/remotes/origin/$PULL_BRANCH" "$FETCHED_REMOTE_SHA" 2>/dev/null || true
    fi
  fi

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
    reconcile_merged_json
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
          reconcile_merged_json
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
      reconcile_merged_json
    elif resolve_conflicts merge && git commit --no-edit 2>/dev/null; then
      echo "  Merge succeeded after auto-resolving conflicts"
      history_changed=true
      RESOLUTION_PATH="merge-resolved"
      restore_protected_fields
      reconcile_merged_json
    else
      echo "  Merge also failed, aborting..."
      git merge --abort 2>/dev/null || true
      # Last resort: reset to remote, then cherry-pick our commit(s) on top.
      # This guarantees we end up ahead of remote with our changes applied.
      echo "  Trying reset + cherry-pick approach..."
      OUR_HEAD=$(git rev-parse HEAD 2>/dev/null || true)
      if [ -n "$OUR_HEAD" ]; then
        # Range-replay EVERY outgoing commit, not just the tip (task #543
        # root cause, 2026-07-26). `git cherry-pick "$OUR_HEAD"` replays only
        # that ONE commit's diff; `git reset --hard origin/$PULL_BRANCH` just
        # above throws away the ENTIRE local branch first. With 2+ outgoing
        # commits this silently dropped every commit except the last —
        # "success" was reported, the push landed, and the earlier commit(s)
        # were gone from main with no error anywhere. Computed BEFORE the
        # reset (which only moves the local branch ref, not origin/$PULL_
        # BRANCH) so it reflects what OUR_HEAD was actually built on.
        MERGE_BASE=$(git merge-base "$OUR_HEAD" "origin/$PULL_BRANCH" 2>/dev/null || true)
        git reset --hard "origin/$PULL_BRANCH" 2>/dev/null || true
        if [ -n "$MERGE_BASE" ] && git cherry-pick "${MERGE_BASE}..${OUR_HEAD}" --strategy-option=theirs 2>/dev/null; then
          echo "  Cherry-pick succeeded (our changes on top of remote)"
          history_changed=true
          RESOLUTION_PATH="reset+cherry-pick(-X theirs)"
          restore_protected_fields
          reconcile_merged_json
        else
          git cherry-pick --abort 2>/dev/null || true
          # Restore must be LOUD (task #543): the old `|| true` here silently
          # swallowed a failed restore, leaving main stuck at the remote tip
          # with every outgoing commit missing — and nothing to report it. A
          # later retry iteration could then trivially "succeed" pushing that
          # commit-less state, so this must fail the WHOLE run, not just fall
          # through to another attempt.
          if git reset --hard "$OUR_HEAD" 2>/dev/null && [ "$(git rev-parse HEAD 2>/dev/null)" = "$OUR_HEAD" ]; then
            echo "  All conflict resolution strategies failed for this attempt"
          else
            echo "::error::push-with-retry: reset+cherry-pick fallback failed AND could not restore HEAD to $OUR_HEAD — local main may be stranded at the remote tip with outgoing commit(s) missing. Recover manually with: git reset --hard $OUR_HEAD"
            restore_head_if_moved "reset-cherry-pick-restore-failed"
            exit 1
          fi
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
        restore_head_if_moved "post-rebase-survival-check-failed"
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

  # ── Post-resolution progress assertion (task #394) ───────────────────────────
  # The push at the top of this iteration was rejected because the remote advanced.
  # If a resolution path CLAIMED success (history_changed=true) yet our HEAD still
  # does NOT contain the fetched remote tip, the rebase/merge was a SILENT NO-OP —
  # it reported "up to date"/"Successfully rebased" but integrated nothing, so the
  # push below and every remaining retry can only be rejected again ("fetch first").
  # That is exactly how the alert-ledger commit failed on all 7 attempts and NEVER
  # persisted from CI (the router's cooldown/dedup state stayed dead). Abort LOUDLY
  # and record it instead of burning the rest of the retry budget on an impossible
  # push. When history_changed=false (a genuine unresolved conflict, or nothing to
  # integrate) we deliberately fall through to the normal backoff/retry — only the
  # "claimed success but did nothing" case is the abort signal. The decision lives
  # in scripts/lib/push-rebase-progress.js (unit-tested, §15). Fail-open if node/git
  # introspection is unavailable — the real fix is the explicit-destination fetch
  # above; this is defense-in-depth against any future stale-ref regression.
  if [ "$history_changed" = "true" ] && [ -n "${FETCHED_REMOTE_SHA:-}" ] \
       && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/push-rebase-progress.js" ]; then
    _remote_in_history=false
    git merge-base --is-ancestor "$FETCHED_REMOTE_SHA" HEAD 2>/dev/null && _remote_in_history=true
    # NOTE: the CLI prints NOOP and exits 3 on a no-op (exit code is the .test.mjs
    # contract). Use `|| true`, NOT `|| echo OK` — the latter APPENDS "OK" to the
    # captured "NOOP" (→ "NOOP\nOK") on the non-zero exit, so the guard would never
    # match and ship inert (ship-check #394 finding). `|| true` fails open: a node
    # crash yields "" (≠ NOOP), a real no-op yields exactly "NOOP".
    if [ "$(node "$SCRIPT_DIR/push-rebase-progress.js" --remote-in-history="$_remote_in_history" --history-changed="$history_changed" 2>/dev/null || true)" = "NOOP" ]; then
      record_push_failure "noop-rebase(${RESOLUTION_PATH:-unknown})" "$i"
      echo "::error::push-with-retry: rebase/merge was a NO-OP (resolution path: ${RESOLUTION_PATH:-unknown}) — the fetched remote tip ${FETCHED_REMOTE_SHA} is still NOT in HEAD's history, so every push attempt will be rejected with 'fetch first'. This is the task-#394 silent-forever failure (a stale refs/remotes/origin/$PULL_BRANCH under a SHA-pinned checkout refspec). Aborting instead of burning $MAX_RETRIES retries. Logged to data/audit/push-retry-failures.jsonl."
      restore_head_if_moved "noop-rebase(${RESOLUTION_PATH:-unknown})"
      exit 1
    fi
  fi

  # If this iteration rewrote history to be pushable, publish it NOW rather than
  # looping back to the top — the deadline guard there could otherwise break after
  # a successful resolution but before the now-pushable commit is ever pushed
  # (ship-check finding, task #183). Bounded by the same per-op timeout; a failure
  # just falls through to the normal backoff + next attempt.
  if [ "$history_changed" = "true" ] && git_push origin "$BRANCH"; then
    if verify_content_survived; then
      echo "Push succeeded after conflict resolution (attempt $i)"
      pushed=true
      break
    else
      echo "::error::push-with-retry: push after conflict resolution (path: ${RESOLUTION_PATH:-unknown}, attempt $i) reported success but our own commit's content is NOT what's on origin/$PULL_BRANCH afterward (task #619) — this iteration's resolution silently discarded it. Resetting local HEAD back to our original commit and retrying instead of reporting false success."
      record_push_failure "commit-dropped-post-push(${RESOLUTION_PATH:-unknown})" "$i"
      git reset --hard "$SCRIPT_ENTRY_HEAD" 2>/dev/null || true
    fi
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
  record_push_failure "retries-exhausted" "$MAX_RETRIES"
  echo "::error::All push attempts failed after $MAX_RETRIES attempts"
  restore_head_if_moved "retries-exhausted"
  exit 1
fi
