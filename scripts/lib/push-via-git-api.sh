#!/usr/bin/env bash
# Push our outgoing file changes onto the CURRENT remote tip via git's Git
# Data API primitives (blob -> tree -> commit -> compare-and-swap ref
# update) instead of a local fetch+rebase+push cycle. Task #707, the
# generalization of the task #698 live fix — see
# memory/feedback_gh_api_emergency_commit.md for the incident this
# fallback exists for.
#
# WHY: push-with-retry.sh's local flow (git fetch, replay our commits on
# top via rebase, push) has a floor cost per attempt. Under sustained high
# main-branch churn that floor cost can be comparable to or slower than
# origin's own advance interval, so the local flow can lose the race
# indefinitely regardless of retry count or deadline (task #698: 20/20
# non-fast-forward losses across 2 runs, each with a 300s deadline and 10
# retries). This script never checks out a working tree and never rebases —
# every retry is: ask the remote for its current tip, build a small set of
# git objects on top of it, then attempt an atomic ref update. Losing that
# race costs a few small git operations, not a full rebase replay.
#
# EQUIVALENCE TO GITHUB'S REST GIT DATA API: the incident that motivated
# this (task #698) used `gh api repos/{owner}/{repo}/git/{blobs,trees,
# commits,refs}` directly (see the memory file above for that exact
# transcript). This script achieves the identical algorithm — and the
# identical benefit (no local checkout, cheap per-retry object
# construction, compare-and-swap ref update) — using git's own plumbing
# against the local object database instead of GitHub's REST endpoints:
#   createBlob   -> objects already exist locally (git ls-tree gives their sha)
#   createTree   -> git read-tree <base> into a scratch index, overlay our
#                   changed paths with update-index, git write-tree
#   createCommit -> git commit-tree
#   updateRef    -> git push <new-sha>:refs/heads/<branch> (git itself
#                   rejects this non-fast-forward if the remote moved,
#                   which IS the force=false compare-and-swap semantic)
# This is deliberately provider-agnostic (works identically against the
# private review-texts/aggregator-archive remotes, not just GitHub-hosted
# public repos) and is what makes this script testable end-to-end against
# a real local bare-repo fixture (see tests/unit/push-via-git-api.test.mjs)
# without any live network dependency or GitHub credentials.
#
# CONFLICT STRATEGY: every path touched between <base_sha> and HEAD wins
# outright — our version replaces whatever the current remote tip has for
# that path. Untouched paths keep the remote tip's content unchanged. This
# mirrors the "keep local" resolution push-with-retry.sh's local flow
# already applies to data/audit/* and data/collection-state/* in
# resolve_conflicts() — it is NOT a per-line/per-key JSON merge (that's
# PUSH_RECONCILE_MERGED_JSON's job, a distinct concern for files like
# commercial.json that need per-slug union semantics). If a file this
# script overwrites also needs union-merge semantics, that reconciliation
# must happen in the LOCAL diff we're replaying (i.e. before base_sha..HEAD
# is computed) — this script has no working tree to run a merge in.
#
# Usage:
#   bash scripts/lib/push-via-git-api.sh <branch> <base_sha> [max_retries]
#
# <base_sha> is the ancestor our outgoing commit(s) are built on — pass the
# caller's already-computed merge-base with the remote (push-with-retry.sh
# passes its SCRIPT_ENTRY_BASE). The diff base_sha..HEAD is what gets
# replayed on top of the live remote tip on every attempt.
#
# Prints the new commit sha to stdout on success. Exits 0 on success, 1 if
# every retry lost the compare-and-swap ref update (or on a non-race
# error). Never touches the caller's working tree, index, or local branch
# ref — the caller is responsible for reconciling local state afterward
# (e.g. `git fetch` + `git reset --hard origin/<branch>`), since the
# commit built here has a different parent lineage than local HEAD.
set -euo pipefail

BRANCH="${1:?usage: push-via-git-api.sh <branch> <base_sha> [max_retries]}"
BASE_SHA="${2:?usage: push-via-git-api.sh <branch> <base_sha> [max_retries]}"
MAX_RETRIES="${3:-6}"
REMOTE="${PUSH_API_REMOTE:-origin}"

# Hard per-op network timeout + git-native low-speed abort (ship-check/Codex
# adversarial-review finding) — this file has no working-tree cost, but its
# network calls (ls-remote/fetch/push) are otherwise UNBOUNDED, reintroducing
# exactly the hang risk push-with-retry.sh's own GIT_NET_TIMEOUT_SEC/
# GIT_LOW_SPEED_TIME hardening (task #183) exists to close. Duplicated here
# (not sourced from push-with-retry.sh) deliberately — this script needs to
# stay a standalone, independently-testable unit with no dependency on that
# file's mutex/trap/EXIT-handler side effects. Same env var names/defaults
# so a caller tuning one tunes both consistently.
GIT_NET_TIMEOUT_SEC=${GIT_NET_TIMEOUT_SEC:-90}
GIT_LOW_SPEED_TIME=${GIT_LOW_SPEED_TIME:-45}
_TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
_timeout() {  # fail-open (run directly) if no timeout binary on this box
  local secs="$1"; shift
  if [ -n "$_TIMEOUT_BIN" ]; then
    "$_TIMEOUT_BIN" -k 10 "$secs" "$@"
  else
    "$@"
  fi
}
_git_net() {
  _timeout "$GIT_NET_TIMEOUT_SEC" \
    git -c "http.lowSpeedLimit=1000" -c "http.lowSpeedTime=${GIT_LOW_SPEED_TIME}" "$@"
}

HEAD_SHA="$(git rev-parse HEAD)"

git rev-parse --verify --quiet "${BASE_SHA}^{commit}" >/dev/null || {
  echo "::error::push-via-git-api: base_sha '$BASE_SHA' is not a valid local commit" >&2
  exit 1
}

# Snapshot the base_sha..HEAD diff ONCE — every retry replays the same
# file list, only the tree we overlay it onto changes.
CHANGED_STATUS=()  # e.g. "M path" / "D path" / "A path"
while IFS= read -r -d '' status && IFS= read -r -d '' path1; do
  case "$status" in
    R*|C*)
      # Rename/copy: name-status emits a THIRD NUL field (new path). Treat
      # as delete-old + add-new so the tree overlay doesn't need to know
      # about renames as a distinct op.
      IFS= read -r -d '' path2
      CHANGED_STATUS+=("D $path1")
      CHANGED_STATUS+=("A $path2")
      ;;
    D)
      CHANGED_STATUS+=("D $path1")
      ;;
    *)
      # A, M, T, etc. — anything else that leaves a real blob at HEAD:path.
      CHANGED_STATUS+=("A $path1")
      ;;
  esac
done < <(git diff --name-status -z "$BASE_SHA" "$HEAD_SHA")

if [ ${#CHANGED_STATUS[@]} -eq 0 ]; then
  echo "::error::push-via-git-api: no file changes between $BASE_SHA and $HEAD_SHA — nothing to push" >&2
  exit 1
fi

COMMIT_MSG="$(git log -1 --format=%B "$HEAD_SHA")"
COMMIT_COUNT="$(git rev-list --count "${BASE_SHA}..${HEAD_SHA}")"
if [ "$COMMIT_COUNT" -gt 1 ]; then
  echo "  push-via-git-api: squashing $COMMIT_COUNT outgoing commits into one API commit (message taken from HEAD's)" >&2
fi

for i in $(seq 1 "$MAX_RETRIES"); do
  CURRENT_TIP="$(_git_net ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
  if [ -z "$CURRENT_TIP" ]; then
    echo "  push-via-git-api: could not resolve $REMOTE/$BRANCH tip (attempt $i/$MAX_RETRIES)" >&2
    sleep $((1 + i))
    continue
  fi

  # Need the tip commit's objects locally to build the overlay tree on top
  # of it. --depth=1 on BOTH the primary (by-sha) and fallback (by-ref)
  # fetch is deliberate, not just cheap: we only ever read $CURRENT_TIP's
  # own tree (read-tree below), never walk its ancestry, so there is no
  # history this script needs beyond the tip commit itself — unlike a
  # rebase-based flow, there is no #466-class case where a depth bound here
  # would break correctness. The fallback exists for remotes that reject
  # fetching an arbitrary commit sha directly (uploadpack.allowReachableSHA1InWant
  # disabled) but do allow a depth-bounded ref fetch. Audited by
  # scripts/audit-unbounded-fetch.js — keep both calls depth-bounded.
  _git_net fetch -q --depth=1 "$REMOTE" "$CURRENT_TIP" 2>/dev/null \
    || _git_net fetch -q --depth=1 "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null \
    || true
  if ! git cat-file -e "${CURRENT_TIP}^{commit}" 2>/dev/null; then
    echo "  push-via-git-api: failed to fetch remote tip $CURRENT_TIP (attempt $i/$MAX_RETRIES)" >&2
    sleep $((1 + i))
    continue
  fi

  TMP_INDEX="$(mktemp)"
  GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$CURRENT_TIP"

  build_ok=true
  for entry in "${CHANGED_STATUS[@]}"; do
    op="${entry%% *}"
    path="${entry#* }"
    if [ "$op" = "D" ]; then
      GIT_INDEX_FILE="$TMP_INDEX" git update-index --force-remove -- "$path" 2>/dev/null || true
    else
      # mode + blob sha straight from HEAD's tree — no re-hashing needed,
      # the object already exists in our local object database.
      lstree_line="$(git ls-tree "$HEAD_SHA" -- "$path")"
      if [ -z "$lstree_line" ]; then
        echo "::error::push-via-git-api: '$path' not found in HEAD's tree (attempt $i)" >&2
        build_ok=false
        break
      fi
      mode="$(printf '%s' "$lstree_line" | cut -d' ' -f1)"
      blob_sha="$(printf '%s' "$lstree_line" | awk '{print $3}')"
      GIT_INDEX_FILE="$TMP_INDEX" git update-index --add --cacheinfo "$mode,$blob_sha,$path"
    fi
  done

  if [ "$build_ok" != "true" ]; then
    rm -f "$TMP_INDEX"
    exit 1
  fi

  NEW_TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
  rm -f "$TMP_INDEX"

  NEW_COMMIT="$(git commit-tree "$NEW_TREE" -p "$CURRENT_TIP" -m "$COMMIT_MSG")"

  PUSH_ERR="$(mktemp)"
  if _git_net push "$REMOTE" "${NEW_COMMIT}:refs/heads/${BRANCH}" >/dev/null 2>"$PUSH_ERR"; then
    rm -f "$PUSH_ERR"
    echo "$NEW_COMMIT"
    exit 0
  fi

  # Race-rejection text varies by transport: smart HTTP/SSH (GitHub) says
  # "non-fast-forward"/"fetch first"/"stale info"; the local/file transport
  # (used by this script's own test fixtures) says "cannot lock ref ... is
  # at X but expected Y" / "failed to update ref" / "[remote rejected]".
  # All are the same condition: our compare-and-swap lost, remote moved.
  if grep -qiE 'non-fast-forward|fetch first|stale info|already exists|cannot lock ref|failed to update ref|remote rejected|\[rejected\]' "$PUSH_ERR"; then
    echo "  push-via-git-api: ref moved during attempt $i/$MAX_RETRIES (remote tip advanced past $CURRENT_TIP) — retrying" >&2
    rm -f "$PUSH_ERR"
    sleep $((1 + RANDOM % 3))
    continue
  fi

  echo "::error::push-via-git-api: push failed for a non-race reason (attempt $i):" >&2
  cat "$PUSH_ERR" >&2
  rm -f "$PUSH_ERR"
  exit 1
done

echo "::error::push-via-git-api: exhausted $MAX_RETRIES attempts, remote tip kept advancing past every build" >&2
exit 1
