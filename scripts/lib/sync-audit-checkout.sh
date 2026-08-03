#!/usr/bin/env bash
# scripts/lib/sync-audit-checkout.sh — shared "am I fresh?" gate for
# launchd-scheduled jobs that share this checkout with GitHub Actions CI
# commits (task #732).
#
# THE BUG THIS CLOSES: a degraded run (missing secret, timeout, crash mid-
# write) can leave a TRUNCATED data/audit/*.json snapshot behind. That dirty
# file then blocks the next job's `git merge --ff-only origin/main`. If the
# caller swallows that failure with `|| echo "...running with local code"`,
# the job silently proceeds on STALE code — and being stale, is itself more
# likely to write another degraded snapshot, re-dirtying the tree. One bad
# run guarantees the next is bad too; local main drifted 269 commits behind
# origin this way before it was caught.
#
# What this script does instead:
#   1. Fetch + attempt a fast-forward merge to origin/main.
#   2. On failure, reset ONLY dirty data/audit/ files that are NOT *.jsonl.
#      Those .jsonl files are append-only ledgers that can hold both a local
#      AND an origin-side append; discarding the local side loses real data.
#      The full-file JSON snapshots under data/audit/ are safe to discard —
#      the next audit run regenerates them from scratch. Then retry the
#      merge.
#   3. If it still can't fast-forward — real local commits ahead of origin,
#      or dirty files outside the safe reset list — FAIL LOUDLY (exit 1)
#      instead of letting the caller fall through to stale code. Callers
#      that chain with `&&` (the launchd inline pattern) get this for free.
#
# Concurrency: this repo runs many launchd jobs and worktree sessions that
# touch the SAME checkout, and merge-worktree-to-main.sh already established
# the convention of serializing mutating git ops here via push-mutex.sh
# (task #556, incidents #208/#543/#546). The reset+merge sequence below is
# mutating (git checkout on data/audit/ paths), so it acquires the same
# mutex — fail-open on timeout, same as every other caller.
#
# Usage: bash scripts/lib/sync-audit-checkout.sh [repo-dir]
# Exits 0 (already fresh, or recovered) or 1 (blocked — investigate).
set -uo pipefail

REPO_DIR="${1:-$(pwd)}"
TAG="${SYNC_TAG:-sync-audit-checkout}"

cd "$REPO_DIR" || { echo "::error::[$TAG] cannot cd to $REPO_DIR"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/push-mutex.sh"
push_mutex_acquire
trap 'push_mutex_release' EXIT

# Depth-bound the fetch when the checkout is shallow. From a `fetch-depth: 1`
# clone an unbounded `git fetch origin main` asks upload-pack for the ref's
# whole history and the server answers with the ENTIRE repo (~2.1 GB / 165k
# commits, measured in run 30218025467), so the job stalls until timeout. This
# helper is reachable from 166 shallow workflows. Same computation as
# push-with-retry.sh — never hand-roll --depth=1, which makes the fetched tip a
# parentless shallow root and destroys ancestry (task #466).
FETCH_DEPTH_ARGS=()
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  # `|| true` is load-bearing: an unborn HEAD must not abort the caller.
  _shallow_base_sha=$(git rev-list HEAD 2>/dev/null | tail -1 || true)
  _shallow_base_epoch=$(git log -1 --format=%ct "${_shallow_base_sha:-HEAD}" 2>/dev/null || echo "")
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/shallow-fetch-args.js" ]; then
    # shellcheck disable=SC2207
    FETCH_DEPTH_ARGS=($(node "$SCRIPT_DIR/shallow-fetch-args.js" \
      --is-shallow=true \
      --oldest-epoch="${_shallow_base_epoch:-}" \
      --slack-sec="${SHALLOW_SINCE_SLACK_SEC:-1800}" 2>/dev/null || true))
  fi
  # Fail CLOSED: an empty array would silently restore the unbounded fetch.
  if [ ${#FETCH_DEPTH_ARGS[@]} -eq 0 ]; then
    FETCH_DEPTH_ARGS=(--deepen=200)
  fi
fi

# unbounded-fetch-ok: depth is bounded by FETCH_DEPTH_ARGS above whenever the
# checkout is shallow; on a full clone no bound is needed or wanted.
if ! git fetch origin main --quiet "${FETCH_DEPTH_ARGS[@]+"${FETCH_DEPTH_ARGS[@]}"}"; then
  echo "::error::[$TAG] git fetch origin main failed"
  exit 1
fi

if git merge --ff-only origin/main --quiet 2>/dev/null; then
  exit 0
fi

echo "[$TAG] ff-only blocked — checking for regenerable data/audit/ snapshots to reset..."

DIRTY_AUDIT_FILES=$( (git diff --name-only -- data/audit/; git diff --cached --name-only -- data/audit/) \
  | sort -u | grep -v '\.jsonl$' || true)

if [ -n "$DIRTY_AUDIT_FILES" ]; then
  echo "[$TAG] resetting regenerable snapshot(s):"
  echo "$DIRTY_AUDIT_FILES" | sed "s/^/[$TAG]   /"
  # `checkout HEAD --` (not bare `checkout --`) so this clears BOTH the
  # index and the working tree — a degraded run that crashed after `git add`
  # but before `git commit` leaves the file staged, and a bare `checkout --`
  # only resets working-tree-vs-index, silently no-op'ing against a staged
  # diff and leaving the merge blocked (caught in review, task #732).
  echo "$DIRTY_AUDIT_FILES" | xargs -I{} git checkout HEAD -- "{}"
fi

if git merge --ff-only origin/main --quiet 2>/dev/null; then
  echo "[$TAG] recovered — fast-forwarded to origin/main after snapshot reset"
  exit 0
fi

echo "::error::[$TAG] ff-only merge still blocked after snapshot reset — real divergence or dirty files outside data/audit/. Refusing to run on stale code."
echo "::error::[$TAG] investigate: git -C '$REPO_DIR' status --short; git -C '$REPO_DIR' rev-list --count HEAD..origin/main"
exit 1
