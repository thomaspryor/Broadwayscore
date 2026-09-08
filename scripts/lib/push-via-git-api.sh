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
# Using git plumbing rather than REST is what makes this script testable
# end-to-end against a real local bare-repo fixture (see
# tests/unit/push-via-git-api.test.mjs) with no live network dependency and
# no GitHub credentials. THAT is the property worth protecting here.
#
# CORRECTION (BRO-2951, 2026-09-08): this block used to also claim the shape
# was "deliberately provider-agnostic (works identically against the private
# review-texts/aggregator-archive remotes, not just GitHub-hosted public
# repos)". That justification was simply false, and it was load-bearing in a
# proposed design before plan-review caught it. Every remote this repo
# pushes to is GitHub — github.com/thomaspryor/broadway-review-texts and
# github.com/thomaspryor/broadway-scorecard-data — and review-texts is in any
# case hard-excluded from this script entirely by push-with-retry.sh's
# _PUSH_API_REPO_EXCLUDED gate, because the API path has no
# restore_protected_fields() step. So "we must stay provider-agnostic for the
# non-GitHub remotes" can never justify a design decision here: there are no
# non-GitHub remotes. The local-fixture testability above is the real
# constraint, and any GitHub-specific path added later must keep the
# git-plumbing path alive and exercised for it.
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

# BRO-2951: escalating backoff for a TIMEOUT-classified push failure only
# (the ref-race branch below keeps its short flat jitter — a lost
# compare-and-swap means the remote genuinely just moved, and retrying fast
# against the new tip is correct; a timeout is a different failure mode).
#
# WHY THIS EXISTS — two failure signatures were confirmed distinct by a live
# local repro (a server that accepts the push body then never responds):
# that genuine dead-hang case is caught CLEANLY by the http.lowSpeedLimit/
# lowSpeedTime guard above at ~46s, with `curl 28 Operation too slow` on
# stderr. Real production failures (data-health-check run 34145757217,
# 2026-09-07) instead hit the FULL ${GIT_NET_TIMEOUT_SEC}s cap via a bare
# SIGTERM (rc=124, EMPTY stderr) on 4/4 attempts, 0 lost races — a
# categorically different signature. Since a truly dead connection is
# already proven to abort in ~45s, something must be trickling enough bytes
# to keep the low-speed average above threshold for the full 90s — i.e. the
# connection is alive, not hung. That, plus the same job's LOCAL (non-API)
# push-with-retry.sh push independently hitting the identical ~91s wall in
# the same window, and dozens of other jobs landing commits to main every
# 5-10s during that window, points at GitHub-side serialization/throttling
# of receive-pack traffic under sustained concurrent push volume from the
# same actor — not a client-side hang this script can fix directly. The
# retry loop was hammering straight back into that state with only a 1-3s
# gap (near-zero backoff), which is the one part of this that IS a bug:
# GitHub's own guidance for secondary rate limits is to back off, not retry
# immediately. Bounds are kept small relative to GIT_NET_TIMEOUT_SEC by
# design — push-with-retry.sh sizes this script's MAX_RETRIES off a
# "~3 * GIT_NET_TIMEOUT_SEC per attempt" cost model (see its own comment
# above the push-via-git-api.sh invocation); at the default MAX_RETRIES=6
# this backoff can add roughly a minute across the full run (5 gaps,
# ~5-19s each) — noticeable but still small next to 6 * 90s of timeouts,
# and push-with-retry.sh only ever grants 6 when there's ample deadline
# left. The scaled-down 2/4-retry paths a tight deadline actually grants
# add well under that.
PUSH_API_TIMEOUT_BACKOFF_BASE_SEC=${PUSH_API_TIMEOUT_BACKOFF_BASE_SEC:-5}
PUSH_API_TIMEOUT_BACKOFF_MAX_SEC=${PUSH_API_TIMEOUT_BACKOFF_MAX_SEC:-15}
# A misconfigured (non-integer, e.g. an accidentally-empty or garbage env
# var) BASE/MAX must never propagate into the arithmetic below: `$((VAR *
# n))` on a non-numeric BASE throws an unbound-variable error under this
# file's `set -u` and aborts the WHOLE retry loop mid-flight (verified via
# a ship-check subagent's repro), and a non-numeric MAX silently defeats the
# `-gt` comparison's clamp instead of erroring — two different failure
# shapes for the same root mistake. Coerce anything that isn't a plain
# integer back to the default rather than either crashing or silently
# misbehaving; a backoff feature degrading to its own default is a fine
# outcome for a bad config, aborting the push fallback entirely is not.
if ! [[ "$PUSH_API_TIMEOUT_BACKOFF_BASE_SEC" =~ ^[0-9]+$ ]]; then
  PUSH_API_TIMEOUT_BACKOFF_BASE_SEC=5
fi
if ! [[ "$PUSH_API_TIMEOUT_BACKOFF_MAX_SEC" =~ ^-?[0-9]+$ ]]; then
  PUSH_API_TIMEOUT_BACKOFF_MAX_SEC=15
fi
# escalating_backoff_sec <cumulative-timeout-count-this-run> -> prints a
# sleep duration to stdout. "Cumulative", not strictly "consecutive": a
# race-classified retry in between two timeouts does not reset the count —
# deliberate, since an intervening race doesn't mean the throttle (if any)
# cleared, so treating the run's timeouts as one escalating series is the
# more conservative reading. Floor-clamped to 1: a misconfigured
# PUSH_API_TIMEOUT_BACKOFF_MAX_SEC of 0 or negative must never reach `sleep`
# with a non-positive argument — `sleep` errors on a negative arg, which
# under this file's `set -euo pipefail` would abort the whole retry loop
# mid-flight instead of just skipping a backoff.
escalating_backoff_sec() {
  local count="$1" backoff
  backoff=$((PUSH_API_TIMEOUT_BACKOFF_BASE_SEC * count))
  if [ "$backoff" -gt "$PUSH_API_TIMEOUT_BACKOFF_MAX_SEC" ]; then
    backoff="$PUSH_API_TIMEOUT_BACKOFF_MAX_SEC"
  fi
  [ "$backoff" -lt 1 ] && backoff=1
  echo "$((backoff + RANDOM % 5))"
}
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

# ---------------------------------------------------------------------------
# BRO-2951 diagnostics: GitHub REST write-latency probe.
#
# Everything below is DIAGNOSTIC ONLY. It never changes which push path runs,
# never mutates a ref, and every failure in it is swallowed — a probe that
# breaks must never break a push. See github-rest-write-probe.js for why a
# blob create (and not a ref read, and emphatically not a scratch-ref push)
# is the measurement that discriminates ref-lock contention from
# actor-level receive-pack throttling.
# ---------------------------------------------------------------------------

# Resolve a GitHub token WITHOUT assuming the caller's step declared one.
#
# THIS IS THE PART THAT WOULD OTHERWISE MAKE ALL OF THIS A NO-OP. The step
# whose failure motivated this card — .github/workflows/data-health-check.yml
# "Commit digest snapshot" — declares ONLY PUSH_DEADLINE_SEC and
# PUSH_API_FALLBACK_AFTER_ATTEMPTS in its env: block. There is no GH_TOKEN and
# no GITHUB_TOKEN. Its pushes authenticate purely off the credential
# actions/checkout persisted into the local git config, and plan-review found
# 51 of 155 push-with-retry.sh callers are in the same shape. Any REST work
# gated on `env has a token` would therefore silently never run in exactly
# the jobs it was built for, and the card would close "fixed" with zero
# behavior change.
#
# actions/checkout stores that credential as
#   http.https://github.com/.extraheader = AUTHORIZATION: basic <base64>
# where the decoded payload is `x-access-token:<token>`.
#
# The resolved value is a SECRET: it is only ever exported into a child
# process's environment, never echoed, never interpolated into a logged
# command line, and never written to a file.
# The two parsers live in a sibling sourceable file so a test can exercise
# the REAL implementations (CLAUDE.md §15) — this script cannot be sourced to
# reach a function, since it runs top-to-bottom under `set -euo pipefail` and
# requires its positional args. Sourced defensively: an absent file must
# degrade the DIAGNOSTIC, never break the push.
_REMOTE_PARSE_OK=0
if [ -f "$SCRIPT_DIR/github-remote-parse.sh" ]; then
  # shellcheck source=./github-remote-parse.sh
  . "$SCRIPT_DIR/github-remote-parse.sh" && _REMOTE_PARSE_OK=1
fi

_resolve_github_token() {
  # Suppress xtrace here too, not only inside the parser. A function's
  # ARGUMENTS are expanded and traced at the CALL SITE, before the callee's
  # body can turn tracing off — so `github_token_from_extraheader "$hdr"`
  # below would print the base64 credential under `bash -x` even though the
  # parser guards its own body. Verified with a canary: guarding only the
  # parser left the base64 blob in the trace; guarding here removes it.
  local _xt=0
  case "$-" in *x*) _xt=1; set +x ;; esac
  _rgt_ret() { [ "$_xt" = "1" ] && set -x; return "$1"; }

  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; _rgt_ret 0; return 0; fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; _rgt_ret 0; return 0; fi
  if [ "$_REMOTE_PARSE_OK" != "1" ]; then _rgt_ret 1; return 1; fi
  local hdr rc=0
  hdr="$(git config --get 'http.https://github.com/.extraheader' 2>/dev/null || true)"
  github_token_from_extraheader "$hdr" || rc=$?
  _rgt_ret "$rc"
  return "$rc"
}

# owner/repo for the remote, but ONLY when it is really github.com. Prints
# nothing (rc 1) for the local filesystem remotes the fixture tests use, so
# the probe can never fire inside a test.
_github_repo_slug() {
  [ "$_REMOTE_PARSE_OK" = "1" ] || return 1
  local url
  url="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
  github_repo_slug_from_url "$url"
}

# Fires at most ONCE per script invocation — a diagnostic that ran on every
# retry would itself add API writes to a repo we may already be throttled on.
# A branch name is caller-supplied and ends up inside a JSON-shaped log
# line, so strip it to a charset that cannot terminate the string or inject
# a newline. Refs cannot legally contain a double quote or backslash anyway;
# this makes the log line structurally safe regardless.
_json_safe() { printf '%s' "${1:-}" | tr -cd '[:alnum:]._/@+-'; }

_REST_PROBE_DONE=0
_rest_write_probe() {
  [ "${PUSH_API_REST_PROBE:-1}" = "1" ] || return 0
  [ "$_REST_PROBE_DONE" = "0" ] || return 0

  # Defense in depth: a caller running this script under `bash -x` / set -x
  # would otherwise print the expanded token assignments below straight into
  # a CI log. `2>/dev/null` suppresses a CHILD's stderr, not the parent
  # shell's xtrace, so suppressing the trace is the only thing that closes
  # it (ship-check/Codex finding). Restored to whatever it was on the way
  # out, including on every early return below.
  local _xt=0
  case "$-" in *x*) _xt=1; set +x ;; esac
  _restore_xt() { [ "$_xt" = "1" ] && set -x; return 0; }

  local slug token out
  slug="$(_github_repo_slug)" || { _restore_xt; return 0; }
  token="$(_resolve_github_token || true)"
  if [ -z "$token" ]; then
    # Loud, because a silent skip here is indistinguishable from "the probe
    # ran and found nothing" — and that ambiguity is what this whole card is
    # about. Names the condition without ever naming the value.
    echo "::warning::push-via-git-api: REST write probe SKIPPED — remote is github.com ($slug) but no token resolved from GH_TOKEN, GITHUB_TOKEN, or the checkout extraheader (BRO-2951)" >&2 || true
    _restore_xt; return 0
  fi
  [ -f "$SCRIPT_DIR/github-rest-write-probe.js" ] || { _restore_xt; return 0; }

  # Only NOW is the single opportunity actually spent. Setting the flag up
  # front (the first draft) let a transient missing precondition permanently
  # consume the run's one diagnostic (ship-check finding).
  _REST_PROBE_DONE=1

  # 20s outer cap against the probe's own 15s socket timeout. This runs only
  # after the retry loop is over (see the call site), so it cannot eat a
  # retry's deadline — but it still must not hang a finished job.
  out="$(GH_TOKEN="$token" _timeout 20 node "$SCRIPT_DIR/github-rest-write-probe.js" "$slug" 2>/dev/null || true)"
  _restore_xt
  if [ -n "$out" ]; then
    echo "  push-via-git-api: push-api-probe rest_write $out" >&2 || true
  else
    # A probe that produced nothing within 20s is itself the slow-REST
    # signal, not an absence of data — say so rather than reporting a bare
    # skip that reads as "we learned nothing".
    echo "  push-via-git-api: push-api-probe rest_write {\"ok\":false,\"skipped\":true,\"reason\":\"no output within the 20s probe cap (itself evidence REST writes are NOT fast for this actor)\"}" >&2 || true
  fi
  return 0
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

# Why each attempt died, so the exhaustion message can state the OBSERVED
# distribution instead of inferring one. The old message asserted "remote tip
# kept advancing past every build" unconditionally, including for runs where
# every attempt died on a 90s timeout and there was no evidence the tip moved
# at all. That false signal is not cosmetic: it is what produced the
# "fetch before the push" cure, which the same logs refute (commercial-rss-poll
# run 33962024987 — fetches complete in 0-2s immediately before each 90s push).
# Same principle already applied at the ALREADY-landed branch below: state the
# observed fact, not an inferred cause.
#
# MUST be assigned with T=$((T+1)), never ((T++)): under this file's
# `set -euo pipefail` (line 66) a post-increment FROM ZERO evaluates to 0 and
# returns status 1, which aborts the script mid-retry with no message —
# silently regressing the timeout-retry path BRO-2823 exists to protect.
FAIL_TIMEOUT=0    # rc=124/137, the timeout wrapper killed the push
FAIL_RACE=0       # the race grep matched: our compare-and-swap lost
FAIL_OTHER=0      # tip unresolved / tip fetch failed — neither of the above

for i in $(seq 1 "$MAX_RETRIES"); do
  CURRENT_TIP="$(_git_net ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
  if [ -z "$CURRENT_TIP" ]; then
    echo "  push-via-git-api: could not resolve $REMOTE/$BRANCH tip (attempt $i/$MAX_RETRIES)" >&2
    FAIL_OTHER=$((FAIL_OTHER + 1))
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
    FAIL_OTHER=$((FAIL_OTHER + 1))
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
    # BRO-2951: report the wall-time of a push that WORKED, not only of one
    # that died. Every timing this card has on record comes from failures, so
    # the success distribution is entirely unknown — and the two hypotheses
    # predict very different ones. If successful ref updates cluster at
    # 40-85s, the 90s cap is simply clipping the tail off a slow-but-working
    # operation and the fix is to raise/measure the cap. If they land in ~2s,
    # then a push either completes almost instantly or not at all, which is
    # the signature of blocking on a lock rather than of transferring slowly.
    # Cheap enough to leave on permanently: one stderr line per successful
    # fallback push. `push-api-probe` is the grep handle across both lines.
    echo "  push-via-git-api: push-api-probe ref_update {\"ok\":true,\"sec\":$((SECONDS - push_start)),\"attempt\":$i,\"branch\":\"$(_json_safe "$BRANCH")\"}" >&2 || true
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
    FAIL_TIMEOUT=$((FAIL_TIMEOUT + 1))
    rm -f "$PUSH_ERR"
    echo "  push-via-git-api: push-api-probe ref_update {\"ok\":false,\"sec\":$((SECONDS - push_start)),\"rc\":$push_rc,\"attempt\":$i,\"branch\":\"$(_json_safe "$BRANCH")\"}" >&2 || true
    # BRO-2951: no point computing or sleeping a backoff on the LAST budgeted
    # attempt — there is no next retry to space out, and doing it anyway
    # wastes up to PUSH_API_TIMEOUT_BACKOFF_MAX_SEC(+jitter) seconds before
    # the exhaustion message and exit code even get reported (ship-check
    # finding: this used to fire unconditionally, same as the pre-existing
    # flat-jitter behavior it replaced, but the escalated amount makes the
    # waste far more noticeable).
    if [ "$i" -lt "$MAX_RETRIES" ]; then
      _backoff="$(escalating_backoff_sec "$FAIL_TIMEOUT")"
      echo "  push-via-git-api: push TIMED OUT after $((SECONDS - push_start))s (rc=$push_rc, cap ${GIT_NET_TIMEOUT_SEC}s) on attempt $i/$MAX_RETRIES — backing off ${_backoff}s before retrying (BRO-2951, see comment above GIT_NET_TIMEOUT_SEC)" >&2
      sleep "$_backoff"
    else
      echo "  push-via-git-api: push TIMED OUT after $((SECONDS - push_start))s (rc=$push_rc, cap ${GIT_NET_TIMEOUT_SEC}s) on attempt $i/$MAX_RETRIES — no attempts remain, skipping backoff" >&2
    fi
    continue
  fi

  # Race-rejection text varies by transport: smart HTTP/SSH (GitHub) says
  # "non-fast-forward"/"fetch first"/"stale info"; the local/file transport
  # (used by this script's own test fixtures) says "cannot lock ref ... is
  # at X but expected Y" / "failed to update ref" / "[remote rejected]".
  # All are the same condition: our compare-and-swap lost, remote moved.
  if grep -qiE 'non-fast-forward|fetch first|stale info|already exists|cannot lock ref|failed to update ref|remote rejected|\[rejected\]' "$PUSH_ERR"; then
    echo "  push-via-git-api: ref moved during attempt $i/$MAX_RETRIES (remote tip advanced past $CURRENT_TIP) — retrying" >&2
    FAIL_RACE=$((FAIL_RACE + 1))
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

# State what actually happened. The "exhausted $MAX_RETRIES attempts" prefix is
# load-bearing and must stay verbatim — tests/unit/push-via-git-api.test.mjs
# asserts on it (plural even when MAX_RETRIES is 1).
# BRO-2951: the discriminating measurement, taken HERE — after the retry
# loop has ended — and ONLY when timeouts are what ended it.
#
# WHY AFTER THE LOOP AND NOT AT THE TIMEOUT ITSELF: the first draft ran this
# inside the timeout branch, before the backoff and the next attempt. An
# adversarial review pointed out that made the "diagnostic only, no behavior
# change" claim FALSE — a probe taking up to its cap on every timeout eats
# the caller's remaining PUSH_DEADLINE_SEC and can cost a later attempt that
# would otherwise have run, in a script whose caller sizes MAX_RETRIES off a
# "~3 * GIT_NET_TIMEOUT_SEC per attempt" cost model. Down here every attempt
# is already spent and the script is exiting regardless, so the measurement
# is genuinely free.
#
# It still satisfies the three conditions that make it worth taking at all:
# the right ACTOR (github-actions[bot], not a developer's laptop — the local
# probing done while diagnosing this card could not isolate the actor, which
# is the gap this closes), the right MOMENT (seconds after receive-pack
# failed to answer, in the same job), and a confirmed TIMEOUT rather than a
# rejection. A REST write that returns promptly here proves the throttle is
# not actor-wide, which is what would make a REST ref-update path the fix; a
# REST write that is ALSO slow proves the opposite and redirects this work to
# BRO-2983. `|| true` because a diagnostic must never change this script's
# exit code.
if [ "$FAIL_TIMEOUT" -gt 0 ]; then
  _rest_write_probe || true
fi

EXHAUSTION_BREAKDOWN="$FAIL_TIMEOUT timed out at the ${GIT_NET_TIMEOUT_SEC}s cap, $FAIL_RACE lost the ref race"
if [ "$FAIL_OTHER" -gt 0 ]; then
  # Without this bucket the message can read "0 timed out, 0 lost the ref race"
  # on a run where every attempt died resolving or fetching the tip — a new
  # version of the same lie the old message told.
  EXHAUSTION_BREAKDOWN="$EXHAUSTION_BREAKDOWN, $FAIL_OTHER could not resolve or fetch the tip"
fi
echo "::error::push-via-git-api: exhausted $MAX_RETRIES attempts: $EXHAUSTION_BREAKDOWN" >&2

# Distinct exit code when TIMEOUTS dominate, so the caller can record WHY the
# fallback died instead of filing every exhaustion as a generic retry cap.
# push-with-retry.sh only tests this for zero/non-zero, so a new non-zero code
# is safe there.
# Ties go TO the timeout signal, deliberately. A strict -gt would file a
# 1-timeout/1-race exhaustion as "(race-or-other)" and drop the timeout from
# the durable ledger — discarding exactly the signal this change exists to
# preserve. The printed breakdown above still reports both counts either way;
# this only decides which reason the caller records.
if [ "$FAIL_TIMEOUT" -gt 0 ] \
  && [ "$FAIL_TIMEOUT" -ge "$FAIL_RACE" ] \
  && [ "$FAIL_TIMEOUT" -ge "$FAIL_OTHER" ]; then
  exit 3
fi
exit 1
