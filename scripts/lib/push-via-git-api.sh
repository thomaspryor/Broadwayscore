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

# BRO-2413: this script's own directory, needed to locate its sibling helper
# scripts (reconcile-merged-json.js, push-via-git-api-merge.js) for the
# apiFallbackMerge path below. Computed here rather than inherited from a
# caller — push-with-retry.sh's own $SCRIPT_DIR is a plain (non-exported)
# shell variable, so a caller invoking `bash push-via-git-api.sh ...` as a
# subprocess (which is how it's ALWAYS invoked, including by every existing
# test in this file) never actually receives it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# BRO-2413: apiFallbackMerge paths (core-data-merge-registry.js's
# apiFallbackMergeEntriesFor('public-repo'), e.g. the multi-writer alert
# ledgers) get REAL reconciliation against the live remote tip instead of
# the plain "ours wins outright" blob overlay every other path below gets —
# see that registry's own comment for why (a genuinely multi-writer file's
# whole-file overwrite would silently drop another writer's entries, which
# is exactly why these paths used to be disqualified from this script
# entirely). Classified ONCE here — our OWN changed-path list never varies
# across retries, only the remote content each attempt merges against does
# (that's computed fresh inside the loop below, per attempt, against
# whatever CURRENT_TIP is that time). Delete ops are excluded: a path
# disappearing from OUR diff has nothing to merge in.
MERGE_CANDIDATE_PATHS=()
for entry in "${CHANGED_STATUS[@]}"; do
  op="${entry%% *}"
  path="${entry#* }"
  [ "$op" = "D" ] && continue
  MERGE_CANDIDATE_PATHS+=("$path")
done
MERGE_PATHS=()
if [ ${#MERGE_CANDIDATE_PATHS[@]} -gt 0 ]; then
  # Fail CLOSED on a classification error (Codex adversarial ship-check P0
  # finding, BRO-2413 round-2): the old `2>/dev/null || true` swallowed ANY
  # failure (missing helper, thrown exception, registry syntax error) into a
  # silently-empty MERGE_PATHS — which would make every apiFallbackMerge
  # candidate fall through to the plain "ours wins outright" overlay below,
  # exactly the hazard this whole mechanism exists to close, with no error
  # surfaced anywhere. A classification failure now aborts the script
  # entirely instead of silently downgrading genuinely multi-writer paths to
  # an unmerged overlay.
  MERGE_CLASSIFY_ERR="$(mktemp)"
  MERGE_CLASSIFY_RC=0
  MERGE_PATHS_RAW="$(node -e '
      const { apiFallbackMergerFor } = require(process.argv[1]);
      for (const p of process.argv.slice(2)) if (apiFallbackMergerFor(p)) console.log(p);
    ' "$SCRIPT_DIR/reconcile-merged-json.js" "${MERGE_CANDIDATE_PATHS[@]}" 2>"$MERGE_CLASSIFY_ERR")" || MERGE_CLASSIFY_RC=$?
  if [ "$MERGE_CLASSIFY_RC" -ne 0 ]; then
    echo "::error::push-via-git-api: apiFallbackMerge path classification failed (rc=$MERGE_CLASSIFY_RC) — aborting rather than silently treating candidate multi-writer paths as safe for a plain overlay:" >&2
    cat "$MERGE_CLASSIFY_ERR" >&2
    rm -f "$MERGE_CLASSIFY_ERR"
    exit 1
  fi
  rm -f "$MERGE_CLASSIFY_ERR"
  while IFS= read -r line; do
    [ -n "$line" ] && MERGE_PATHS+=("$line")
  done <<< "$MERGE_PATHS_RAW"
fi
is_merge_path() {
  local needle="$1" p
  for p in "${MERGE_PATHS[@]:-}"; do
    [ "$p" = "$needle" ] && return 0
  done
  return 1
}

# BRO-2413 round-2 (Codex adversarial ship-check P0 finding): reads
# <commit>:<path> into <outfile>, distinguishing "path genuinely does not
# exist in <commit>'s tree" (a real, expected case the merge functions
# already handle — writes empty and returns 0) from "the path IS in the
# tree but its blob failed to read" (object-store corruption, a transient
# I/O error — NOT legitimate absence; returns 1 with nothing written, so
# the caller can fail closed instead of silently treating a live commit's
# actual content as empty). Used for CURRENT_TIP's remote read below, where
# that distinction changes the merge's outcome (a real absence vs. a
# missed real entry are not the same thing for a multi-writer file).
read_blob_or_absent() {
  local commit="$1" path="$2" outfile="$3"
  local lstree_line blob_sha errfile
  lstree_line="$(git ls-tree "$commit" -- "$path" 2>/dev/null)"
  if [ -z "$lstree_line" ]; then
    : > "$outfile"
    return 0
  fi
  blob_sha="$(printf '%s' "$lstree_line" | awk '{print $3}')"
  errfile="$(mktemp)"
  if git cat-file blob "$blob_sha" > "$outfile" 2>"$errfile"; then
    rm -f "$errfile"
    return 0
  fi
  echo "::error::push-via-git-api: '$path' exists in ${commit}'s tree but its blob $blob_sha failed to read:" >&2
  cat "$errfile" >&2
  rm -f "$errfile"
  return 1
}

for i in $(seq 1 "$MAX_RETRIES"); do
  CURRENT_TIP="$(_git_net ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
  if [ -z "$CURRENT_TIP" ]; then
    echo "  push-via-git-api: could not resolve $REMOTE/$BRANCH tip (attempt $i/$MAX_RETRIES)" >&2
    sleep $((1 + i))
    continue
  fi

  # Need the tip commit's objects locally to build the overlay tree on top
  # of it. Skip the fetch entirely when we already have it — the common case
  # once this script is invoked repeatedly against the same shared checkout
  # (e.g. CURRENT_TIP is our own already-pushed HEAD or an ancestor we
  # already hold). This is not just an optimization: task #1847 found that
  # `git fetch --depth=1 <remote> <sha>` SHALLOW-GRAFTS the local repository
  # as a side effect EVEN WHEN <sha> and its full ancestry are already
  # present locally — flipping `is-shallow-repository` to true and silently
  # truncating `git log`/`git rev-list`/`merge-base --is-ancestor` traversal
  # at that commit for the REST of that checkout's lifetime (confirmed via a
  # minimal repro: a non-shallow 3-commit repo, `git fetch --depth=1 origin
  # <local-HEAD-sha>`, and the repo is shallow afterward with `git log`
  # showing only that one commit). This script's own header promises it
  # "never touches the caller's working tree, index, or local branch ref" —
  # an undocumented shallow-graft of the shared object database breaks that
  # promise and corrupts every other ancestry-dependent guard in
  # push-with-retry.sh (BRO-259 checks, orphan-commit checks) for as long as
  # that checkout persists, which matters for the ~20 local scripts calling
  # push-with-retry.sh against the PERSISTENT shared checkout (unlike CI's
  # disposable one) — see push-with-retry.sh's task #1489 comment. If a
  # fetch IS genuinely needed (the object is missing), depth-bound it only
  # when the repo is ALREADY shallow (nothing new to lose — matches the
  # disposable-CI-checkout population this script was designed for);
  # otherwise fetch without a depth bound so a currently-full checkout stays
  # full. unbounded-fetch-ok: gated on is-shallow-repository=false, git's own
  # negotiation against existing haves keeps this cheap — audited by
  # scripts/audit-unbounded-fetch.js.
  if ! git cat-file -e "${CURRENT_TIP}^{commit}" 2>/dev/null; then
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      _git_net fetch -q --depth=1 "$REMOTE" "$CURRENT_TIP" 2>/dev/null \
        || _git_net fetch -q --depth=1 "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null \
        || true
    else
      _git_net fetch -q "$REMOTE" "$CURRENT_TIP" 2>/dev/null \
        || _git_net fetch -q "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null \
        || true
    fi
  fi
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

      if is_merge_path "$path"; then
        # BRO-2413: reconcile against CURRENT_TIP's live copy of this path
        # instead of overlaying our raw blob outright. Re-run EVERY attempt
        # (not just once) — CURRENT_TIP is whatever the remote tip actually
        # is THIS attempt, and that's the whole reason retries exist here.
        # BASE_SHA's copy is also re-fetched each attempt (cheap — local
        # object reads, no network) rather than cached once outside the
        # loop, trading a little redundant work for not having to reason
        # about cache invalidation across retries.
        REMOTE_TMP="$(mktemp)"
        OURS_TMP="$(mktemp)"
        BASE_TMP="$(mktemp)"
        # Remote read: fail CLOSED on a real error, not just "absent" (see
        # read_blob_or_absent's own header — this is the fix for the P0
        # Codex's round-2 verification pass flagged). A silent empty
        # substitution here would make the merge run as if remote's ACTUAL
        # current entries don't exist, letting our commit win the CAS while
        # dropping content that genuinely IS on the tip we're building on.
        if ! read_blob_or_absent "$CURRENT_TIP" "$path" "$REMOTE_TMP"; then
          rm -f "$REMOTE_TMP" "$OURS_TMP" "$BASE_TMP"
          build_ok=false
          break
        fi
        # Base read: tolerant of failure by design, NOT a fail-open bug —
        # base is an OPTIONAL three-way input (see merge-alert-ledger.js's
        # header). Every merge function already treats a missing/unparsable
        # base identically to a genuinely-absent one: the more conservative
        # two-way fallback (every remote-only entry restored, no deletion
        # detection). A base-read failure therefore never causes data loss,
        # only forgoes the deletion-detection optimization for this attempt —
        # unlike the remote read above, there is no unsafe outcome to guard
        # against here.
        git show "${BASE_SHA}:${path}" > "$BASE_TMP" 2>/dev/null || : > "$BASE_TMP"
        # Fail CLOSED on OUR OWN blob read (Codex adversarial ship-check P0
        # finding, BRO-2413 round-2): unlike CURRENT_TIP's remote read above
        # (whose absence is a legitimate "path doesn't exist there yet"
        # case the merge functions already handle), $blob_sha came straight
        # out of `git ls-tree $HEAD_SHA` moments ago — it is guaranteed to
        # exist in our OWN local object database. A `git cat-file` failure
        # here means something is actually wrong (object-store corruption,
        # a transient filesystem error), not "legitimately absent" — silently
        # substituting empty content would make the merge run as if OUR
        # change never happened, letting remote's content win outright for a
        # path we know is multi-writer. Abort the attempt instead.
        CAT_FILE_ERR_TMP="$(mktemp)"
        if ! git cat-file blob "$blob_sha" > "$OURS_TMP" 2>"$CAT_FILE_ERR_TMP"; then
          echo "::error::push-via-git-api: failed to read our own blob $blob_sha for apiFallbackMerge path '$path' (attempt $i) — aborting rather than merging against empty content:" >&2
          cat "$CAT_FILE_ERR_TMP" >&2
          rm -f "$REMOTE_TMP" "$OURS_TMP" "$BASE_TMP" "$CAT_FILE_ERR_TMP"
          build_ok=false
          break
        fi
        rm -f "$CAT_FILE_ERR_TMP"
        MERGED_TMP="$(mktemp)"
        MERGE_STDERR_TMP="$(mktemp)"
        if node "$SCRIPT_DIR/push-via-git-api-merge.js" "$path" "$OURS_TMP" "$REMOTE_TMP" "$BASE_TMP" > "$MERGED_TMP" 2>"$MERGE_STDERR_TMP"; then
          cat "$MERGE_STDERR_TMP" >&2
          merged_blob_sha="$(git hash-object -w "$MERGED_TMP")"
          rm -f "$REMOTE_TMP" "$OURS_TMP" "$BASE_TMP" "$MERGED_TMP" "$MERGE_STDERR_TMP"
          GIT_INDEX_FILE="$TMP_INDEX" git update-index --add --cacheinfo "$mode,$merged_blob_sha,$path"
        else
          # Fail CLOSED — never fall through to the plain "ours wins" overlay
          # below for a path we KNOW is genuinely multi-writer; that would
          # silently reintroduce the exact hazard apiFallbackMerge exists to
          # close.
          echo "::error::push-via-git-api: apiFallbackMerge reconciliation failed for '$path' (attempt $i) — aborting rather than falling back to an unmerged overlay:" >&2
          cat "$MERGE_STDERR_TMP" >&2
          rm -f "$REMOTE_TMP" "$OURS_TMP" "$BASE_TMP" "$MERGED_TMP" "$MERGE_STDERR_TMP"
          build_ok=false
          break
        fi
      else
        GIT_INDEX_FILE="$TMP_INDEX" git update-index --add --cacheinfo "$mode,$blob_sha,$path"
      fi
    fi
  done

  if [ "$build_ok" != "true" ]; then
    rm -f "$TMP_INDEX"
    exit 1
  fi

  NEW_TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
  rm -f "$TMP_INDEX"

  # A prior attempt's push can land server-side and still be reported as a
  # failure here, because the timeout wrapper SIGTERMs the client before it
  # reads the response (see the rc=124 branch below). When that happens the
  # next attempt re-reads CURRENT_TIP as OUR OWN landed commit and replays the
  # same snapshotted CHANGED_STATUS/HEAD_SHA overlay onto it, so NEW_TREE comes
  # out identical to the tip's tree and commit-tree would mint an EMPTY commit
  # — pushing it fires every push-driven workflow for no content change. No
  # data loss either way, but the no-op push is pure noise, so detect it and
  # report the already-landed commit instead. verify_content_survived in
  # push-with-retry.sh still passes on this sha, because the content it checks
  # for is exactly what a prior attempt put there.
  # State the OBSERVED fact, not an inferred cause. A killed-but-landed push is
  # the motivating case, but the same condition is reached when a sibling writer
  # pushed byte-identical content, or when our diff only deletes paths already
  # absent from the tip — and it can fire on i=1, where "a prior attempt" is
  # impossible. Naming a cause we did not observe is the exact error this commit
  # exists to correct.
  CURRENT_TIP_TREE="$(git rev-parse "${CURRENT_TIP}^{tree}" 2>/dev/null || true)"
  if [ -n "$CURRENT_TIP_TREE" ] && [ "$NEW_TREE" = "$CURRENT_TIP_TREE" ]; then
    echo "  push-via-git-api: our overlay applied to $CURRENT_TIP yields that same tree, so our content is ALREADY on ${BRANCH} (attempt $i) — reporting the existing commit instead of minting an empty one" >&2
    echo "$CURRENT_TIP"
    exit 0
  fi

  NEW_COMMIT="$(git commit-tree "$NEW_TREE" -p "$CURRENT_TIP" -m "$COMMIT_MSG")"

  PUSH_ERR="$(mktemp)"
  push_start=$SECONDS
  # `$?` is NOT usable after a bare `if ... ; then ... fi` with no else: a false
  # condition with no else branch leaves the compound statement's own status at
  # 0, so the rc of the push is gone by `fi`. Capture it in the else branch,
  # matching push-with-retry.sh:1373-1381's shape for the same problem.
  if _git_net push "$REMOTE" "${NEW_COMMIT}:refs/heads/${BRANCH}" >/dev/null 2>"$PUSH_ERR"; then
    rm -f "$PUSH_ERR"
    echo "$NEW_COMMIT"
    exit 0
  else
    push_rc=$?
  fi

  # TIMEOUT IS NOT A FATAL ERROR. _git_net wraps every network op in
  # `timeout -k 10 $GIT_NET_TIMEOUT_SEC`, so a push that burns the full cap is
  # SIGTERMed (rc=124), or SIGKILLed 10s later if it ignores that (rc=137).
  # git dies without writing to stderr in both cases, so PUSH_ERR is EMPTY, the
  # race-text grep below cannot match, and control used to fall through to the
  # fatal branch — printing "push failed for a non-race reason" with NOTHING
  # after the colon and exiting, abandoning every remaining budgeted attempt.
  # Measured in two workflows, both with an empty reason: data-health-check run
  # 33922438634 at 90.66s and commercial-rss-poll run 33929580504 at 90.1s.
  # A timeout means "still too slow", not "will never work", so retry it like a
  # lost race. Bounded by MAX_RETRIES, which push-with-retry.sh already scales
  # to 2/4/6 by remaining PUSH_DEADLINE_SEC.
  if [ "$push_rc" -eq 124 ] || [ "$push_rc" -eq 137 ]; then
    echo "  push-via-git-api: push TIMED OUT after $((SECONDS - push_start))s (rc=$push_rc, cap ${GIT_NET_TIMEOUT_SEC}s) on attempt $i/$MAX_RETRIES — retrying rather than treating a timeout as fatal" >&2
    rm -f "$PUSH_ERR"
    sleep $((1 + RANDOM % 3))
    continue
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

  # Always name the rc. An empty PUSH_ERR used to make this message
  # indistinguishable from a timeout, which is how the real cause stayed
  # unread across two workflows for days.
  echo "::error::push-via-git-api: push failed for a non-race reason (attempt $i, rc=$push_rc):" >&2
  if [ -s "$PUSH_ERR" ]; then
    cat "$PUSH_ERR" >&2
  else
    echo "  (git wrote nothing to stderr — rc=$push_rc)" >&2
  fi
  rm -f "$PUSH_ERR"
  exit 1
done

echo "::error::push-via-git-api: exhausted $MAX_RETRIES attempts, remote tip kept advancing past every build" >&2
exit 1
