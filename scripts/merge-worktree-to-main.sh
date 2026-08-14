#!/usr/bin/env bash
#
# merge-worktree-to-main.sh — safely integrate a worktree branch into main and push.
#
# WHY THIS EXISTS
#   `git pull --rebase` SILENTLY DROPS merge commits. Hand-rolled worktree
#   integration has therefore "pushed successfully" while the work was missing
#   from origin (2026-06-21 incident; memory/feedback_pull_rebase_drops_merge_commits.md).
#   This script encodes the only-safe sequence so no session improvises it again:
#     1. integrate origin with `git merge` (NEVER rebase),
#     2. merge the worktree branch (preserves the commits),
#     3. push with merge-based retry if origin moved,
#     4. VERIFY the changed files actually exist on origin/main, exit non-zero if not.
#   It also beats the background data-daemon that constantly rewrites
#   data/audit + cloud-memory + public/data/admin (which otherwise blocks merges).
#
# USAGE
#   scripts/merge-worktree-to-main.sh [branch] [-- file1 file2 ...]
#     branch   worktree branch to integrate (default: current branch)
#     files    paths that MUST exist on origin/main after push
#              (default: the files the branch changed vs main)
#   DRY_RUN=1 scripts/merge-worktree-to-main.sh   # do everything except the push
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/lib/push-mutex.sh"
# shellcheck source=scripts/lib/disk-floor-check.sh
source "$SCRIPT_DIR/lib/disk-floor-check.sh"
ensure_disk_floor   # task #968: self-heal low-disk before the merge+push that needs the space

die() { push_mutex_release; echo "❌ $*" >&2; exit 1; }
log() { echo "→ $*"; }

# --- Parse args: optional branch, optional "-- files..." ---
BRANCH=""; VERIFY_FILES=()
if [ "${1:-}" = "--" ]; then shift; VERIFY_FILES=("$@");
else
  [ $# -gt 0 ] && { BRANCH="$1"; shift; }
  [ "${1:-}" = "--" ] && shift
  VERIFY_FILES=("$@")
fi

# --- Locate the main worktree (first entry of `git worktree list`) ---
MAIN_DIR=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[ -n "$MAIN_DIR" ] && [ -d "$MAIN_DIR" ] || die "could not locate main worktree via 'git worktree list'"
g() { git -C "$MAIN_DIR" "$@"; }

DEFAULT_BRANCH=$(g symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=main

# --- Resolve branch to integrate ---
[ -z "$BRANCH" ] && BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$BRANCH" ] || die "no branch given and could not detect current branch"
[ "$BRANCH" = "$DEFAULT_BRANCH" ] && die "branch '$BRANCH' is the default branch — nothing to integrate"
g rev-parse --verify "$BRANCH" >/dev/null 2>&1 || die "branch '$BRANCH' not found"

log "main worktree: $MAIN_DIR"
log "integrating branch: $BRANCH → $DEFAULT_BRANCH"

# --- Default the verify list to the branch's changed files ---
# Deletions go in their own list: for a removed path the correct assertion is
# ABSENT-on-origin, not present. Lumping them in made any pure-deletion merge
# report "push reported success but work is missing" while the deletion had in
# fact landed (observed 2026-08-01 removing scripts/verify-we-backfill.test.mjs),
# which trains the operator to ignore the one alarm that exists to catch #619/#668.
DELETED_FILES=()
# Fork point, captured HERE and reused by the content-survival check at the end
# of this script. It MUST be computed before any merging: once we merge $BRANCH
# into $DEFAULT_BRANCH (and especially once another session pushes our local
# main to origin, which happens constantly at this concurrency), $BRANCH becomes
# an ancestor of both, every merge-base against them collapses to $BRANCH's own
# tip, and a diff from there is empty — the check would silently compare NOTHING
# and still print OK. Observed live on the very first production run of that
# check (2026-08-02): "OK — no modified files to check" on a merge that changed
# 5 files. Computed unconditionally (not only when VERIFY_FILES is empty) so an
# explicit `-- file...` caller list doesn't leave it unset.
CONTENT_FORK_BASE=$(g merge-base "$DEFAULT_BRANCH" "$BRANCH" 2>/dev/null || true)
if [ ${#VERIFY_FILES[@]} -eq 0 ]; then
  MB="$CONTENT_FORK_BASE"
  if [ -n "$MB" ]; then
    while IFS= read -r f; do [ -n "$f" ] && VERIFY_FILES+=("$f"); done \
      < <(g diff --name-only --diff-filter=d "$MB" "$BRANCH" 2>/dev/null)
    # --no-renames on the DELETED side only. With rename detection on (the
    # default), `git mv a b` reports a single R entry naming only `b`, so the
    # vanished path `a` lands in NEITHER list and a rename whose delete-half
    # failed to push would verify green. --no-renames decomposes it into
    # add(b) + delete(a), putting `a` back under -D where it belongs.
    while IFS= read -r f; do [ -n "$f" ] && DELETED_FILES+=("$f"); done \
      < <(g diff --name-only --no-renames --diff-filter=D "$MB" "$BRANCH" 2>/dev/null)
  fi
fi
log "will verify ${#VERIFY_FILES[@]} file(s) present + ${#DELETED_FILES[@]} deleted on origin after push"

# ── Local push mutex (task #556) ─────────────────────────────────────────────
# The whole flow below — stash, checkout main, fetch+merge origin, merge the
# worktree branch, push, verify — operates on the SHARED main worktree
# directory ($MAIN_DIR) and origin's ref. Two concurrent sessions running this
# script interleave on both, which is exactly the #546 incident class
# (concurrent session reset origin's tip between this script's push and its
# own verify step). Acquire before touching anything and release via the EXIT
# trap on every path, including die(). Fails OPEN on timeout: the existing
# ancestor-check verify step below remains as defense in depth. See
# scripts/lib/push-mutex.sh.
push_mutex_acquire
trap 'push_mutex_release' EXIT

# --- Stash any dirty tracked files (the data-daemon race) ---
STASHED=0
if ! g diff --quiet 2>/dev/null || ! g diff --cached --quiet 2>/dev/null; then
  log "working tree dirty (likely the data daemon) — stashing"
  g stash push -m "wt-integ-$$" >/dev/null 2>&1 && STASHED=1
fi

restore_stash() {
  [ "$STASHED" = 1 ] || return 0
  if ! g stash pop >/dev/null 2>&1; then
    # This fallback used to assume stash-pop conflicts are ALWAYS in auto-
    # generated state files and blindly `checkout HEAD -- .` across the WHOLE
    # working tree. That's wrong whenever this fires while `git merge $BRANCH`
    # (above) is itself mid-conflict: the conflicted path is then the branch's
    # REAL change, and `checkout HEAD -- .` silently overwrites it with main's
    # stale content — merge reports "resolve manually" but the file has
    # already been wrongly "resolved" underneath that message (task #888,
    # 2026-08-02: scripts/lib/sync-audit-checkout.sh's real fix was discarded
    # this way).
    #
    # The real signal for "is there branch content at risk here" is whether a
    # `git merge` is actually mid-conflict (MERGE_HEAD present), NOT a static
    # path allowlist — this repo's local daemon churns far more than
    # cloud-memory/, data/audit/, public/data/admin/ (e.g. public/data/shows/
    # is `merge-coverage=exempt` in .gitattributes and among the highest-churn
    # dirs in the repo). A path-allowlist that's too narrow would make
    # ORDINARY daemon churn take the "leave it alone" branch below and wedge
    # the shared main worktree for every session until an operator manually
    # intervenes — trading one silent-wrong-content bug for a
    # blocks-everyone-on-routine-churn bug. So: no MERGE_HEAD means nothing
    # here is a genuine branch merge conflict, and a full reset is lossless
    # (the stash pop failed, so git never dropped the stash entry — it's
    # still recoverable via `git stash list` if the discarded churn mattered).
    if ! g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
      log "stash pop conflicted with no merge in progress — discarding stashed churn (reset --hard HEAD)"
      g reset --hard HEAD >/dev/null 2>&1 || true
      g stash drop >/dev/null 2>&1 || true
      return 0
    fi
    # MERGE_HEAD is set: `git merge $BRANCH` above is genuinely mid-conflict
    # and the stash-pop conflict landed on top of it. Only auto-resolve paths
    # we can PROVE are the known daemon-churn set; anything else, leave
    # untouched and fail loudly so the genuine merge conflict stays visible
    # instead of being papered over.
    local unmerged unsafe
    unmerged=$(g diff --name-only --diff-filter=U 2>/dev/null)
    if [ -z "$unmerged" ]; then
      # Nothing actually unmerged — stash pop failed for some other reason.
      # Nothing to auto-resolve; drop the stash and move on.
      g stash drop >/dev/null 2>&1 || true
      return 0
    fi
    unsafe=""
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$f" in
        cloud-memory/*|data/audit/*|public/data/admin/*) ;;
        *) unsafe+="$f"$'\n' ;;
      esac
    done <<< "$unmerged"
    if [ -n "$unsafe" ]; then
      log "⚠ stash pop conflicted on non-auto-gen path(s) mid-merge — NOT auto-resolving (would risk silently discarding the real merge conflict, see task #888):"
      echo "$unsafe" | sed 's/^/    /' >&2
      return 1
    fi
    log "stash pop conflicted on auto-gen files only — taking committed version for those paths"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      g checkout HEAD -- "$f" >/dev/null 2>&1 || true
    done <<< "$unmerged"
    g stash drop >/dev/null 2>&1 || true
  fi
}

# --- Ensure main is checked out, then MERGE (never rebase) ---
g checkout "$DEFAULT_BRANCH" >/dev/null 2>&1 || { restore_stash; die "could not checkout $DEFAULT_BRANCH"; }

log "fetch + merge origin/$DEFAULT_BRANCH (no rebase)"
g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || log "  ⚠ fetch failed (offline?) — continuing with cached ref"
# Diff base for the post-merge syntax floor below: origin's CURRENT tip, not
# local HEAD before this run. A prior invocation that died AFTER merging but
# BEFORE pushing (e.g. the syntax check below caught a collision) leaves the
# broken merge commit sitting in $MAIN_DIR — a naive "diff since local HEAD at
# script start" would then see NO new changes on retry (both merges become
# no-ops) and silently push the still-broken commit. Anchoring to origin's tip
# instead always answers the question that actually matters — "does what
# we're about to push differ from what's live, and does that diff parse" —
# regardless of how many retries it took to get here.
ORIGIN_BASE_SHA=$(g rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null || g rev-parse HEAD)
if ! g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of origin/$DEFAULT_BRANCH failed — resolve manually"
fi

log "merge $BRANCH"
if ! g merge "$BRANCH" --no-edit >/dev/null 2>&1; then
  restore_stash; die "merge of $BRANCH failed — resolve manually"
fi

# --- Post-merge JS syntax floor (card 3aa637c5, 2026-07-26 collision incident) ---
# Two concurrent sessions can each cleanly insert the identical line into a
# destructured require() at the same spot; git's 3-way merge doesn't treat
# that as a conflict (each diff applies against its own base, e.g. session A's
# commit lands in origin/main above, then session B's independent commit
# merges in here on top) — the RESULT can still fail to parse ("Identifier
# 'x' has already been declared") with zero git-level conflict. This exact
# incident (shouldShowSentiment double-declared across two sessions' fixes)
# broke main CI for ~10min until a manual dedup commit (3d9caac467c). `node
# --check` on every scripts/**/*.{js,mjs,cjs} file this integration touched
# catches that class instantly and for free, LOCALLY, before the broken merge
# ever reaches origin — instead of waiting for CI to turn main red. Scoped to
# scripts/ only, mirroring the proven tier-3 syntax-floor check in
# scripts/lib/autonomous-checks.js (`node --check` per changed scripts/ file)
# — src/ has JSX/TSX that `node --check` cannot parse; that's tsc's job
# (CLAUDE.md rule 12), unaffected by this addition.
SYNTAX_CHECK_FILES=()
while IFS= read -r f; do
  case "$f" in
    scripts/*.js|scripts/*.mjs|scripts/*.cjs) SYNTAX_CHECK_FILES+=("$f") ;;
  esac
done < <(g diff --name-only --diff-filter=d "$ORIGIN_BASE_SHA" HEAD 2>/dev/null)
if [ ${#SYNTAX_CHECK_FILES[@]} -gt 0 ]; then
  log "syntax-checking ${#SYNTAX_CHECK_FILES[@]} changed scripts/ file(s) (post-merge floor)"
  SYNTAX_FAIL=0
  for f in "${SYNTAX_CHECK_FILES[@]}"; do
    [ -f "$MAIN_DIR/$f" ] || continue
    if ! ERR=$(node --check "$MAIN_DIR/$f" 2>&1); then
      echo "  ✗ $f" >&2
      echo "$ERR" | sed 's/^/      /' >&2
      SYNTAX_FAIL=1
    fi
  done
  if [ "$SYNTAX_FAIL" = 1 ]; then
    restore_stash
    die "post-merge syntax check failed — likely a concurrent-session collision (two branches independently edited the same file; see Notion card 3aa637c5). Resolve the duplication in $MAIN_DIR, commit the fix, then re-run this script."
  fi
fi

# --- Range-scoped push audits (card #835) ---
# scripts/hooks/pre-push runs these gates (audit-unbounded-fetch,
# audit-tests-vs-derived-data, audit-orphan-tests,
# audit-playwright-evaluate-click, lint-write-routing.sh) at PUSH time — but
# this script previously ran none of them, so a violating worktree branch
# merged straight onto local main unaudited. The gate then blocked the WRONG
# person: whoever next ran `git push` on main ate a failure someone else
# introduced (two such incidents inside one hour on 2026-08-02: an
# unregistered test and an unbounded-fetch violation, both fixed by a
# downstream session that was merely trying to push something unrelated).
# Sharing scripts/lib/run-push-audits.sh with the hook means both call sites
# run the identical gate list — they cannot drift apart. Same diff anchor
# ($ORIGIN_BASE_SHA vs HEAD) as the syntax-floor check above.
AUDIT_CHANGED_FILES=$(g diff --name-only "$ORIGIN_BASE_SHA" HEAD 2>/dev/null || true)
if [ -n "$(echo "$AUDIT_CHANGED_FILES" | tr -d '[:space:]')" ]; then
  log "running push audits on ${BRANCH}'s changes (scripts/lib/run-push-audits.sh)"
  if ! AUDIT_OUT=$( (cd "$MAIN_DIR" && echo "$AUDIT_CHANGED_FILES" | bash scripts/lib/run-push-audits.sh) 2>&1 ); then
    echo "$AUDIT_OUT" >&2
    echo "" >&2
    echo "(Bypass ONLY for a genuine emergency: fix on $BRANCH and re-run, or" >&2
    echo " manually 'git merge $BRANCH --no-edit' + 'git push --no-verify'.)" >&2
    # Deliberately NOT `git reset --hard` here — same reasoning as the
    # syntax-floor check above: $ORIGIN_BASE_SHA anchors to origin's tip at
    # run start, not to local main's state before THIS merge. A prior
    # invocation of this script can die after merging but before pushing
    # (see the ORIGIN_BASE_SHA comment above), leaving an unrelated,
    # not-yet-pushed merge sitting in $MAIN_DIR. Resetting to $ORIGIN_BASE_SHA
    # would silently discard that other work too. Push never happens on this
    # path (die() below exits before the push section), so origin is
    # unaffected either way — leave $MAIN_DIR for the operator to resolve,
    # exactly like the syntax-floor failure does.
    restore_stash
    die "push audits failed on $BRANCH's changes — merge refused (not pushed). Resolve the violation in $MAIN_DIR (fix on $BRANCH and re-merge, or fix directly and commit), then re-run this script."
  fi
fi

# --- Post-merge TEST floor (task #1149) ─────────────────────────────────────
# The syntax floor above (`node --check`) catches parse-level collisions but
# not semantic ones: two branches can each be individually correct and pass
# their OWN pre-merge test runs, yet the MERGED tree fails a colocated
# contract test that only exists because of the OTHER branch. Reproduced
# 2026-08-09: a worktree branched at 16:24, another session's commit
# (ingest-skip-classify.js + its contract test) landed on origin at 16:31,
# local runs at 16:33-16:38 were green because that test didn't exist yet at
# the branch point, this script merged origin in at 16:41 and pushed, and CI
# went red minutes later. Running the full suite BEFORE the merge — exactly
# what that session had already done — cannot catch this class; the
# colliding test only exists WITH the merge. Run the colocated
# scripts/lib/*.test.mjs suite (same glob CI's own "Run scripts/lib tests"
# step uses) against the MERGED tree, BEFORE push, whenever any scripts/lib
# file changed on this diff — same $ORIGIN_BASE_SHA..HEAD anchor as the
# syntax floor and push audits above. A failure refuses to push and leaves
# the branch intact, same recovery shape as those checks.
#
# Kill switch (adversarial-review finding, same pattern as
# PUSH_SKIP_CONTENT_SURVIVAL_CHECK below): without an escape hatch, a
# false-positive storm here would wedge every session's merges with no way
# out except editing this script under pressure — MERGE_SKIP_POST_MERGE_TEST_GATE=1
# gives an immediate, auditable bypass of the WHOLE gate instead.
#
# Blocks only NEW failures, not pre-existing ones (card #1433). The floor
# used to block on ANY failing scripts/lib/*.test.mjs test, including ones
# already red on origin/main before this branch touched anything — 3
# main-red incidents in 3 days traced to exactly that gap (a branch refused
# for a stale assertion some OTHER refactor broke). merge-post-merge-test-gate.js
# now builds a disposable baseline checkout of $ORIGIN_BASE_SHA (the exact
# origin tip THIS merge pulled in — passed below, not "whatever origin/main
# drifts to by the time the gate runs") and only blocks on a failure that's
# NEW since then; a pre-existing failure is reported loudly but does not
# block. If the baseline checkout itself can't be built, the gate fails safe
# to the old all-or-nothing behavior. Narrower escape hatch just for that
# half: MERGE_TEST_GATE_SKIP_BASELINE=1 (forces old behavior without
# disabling the floor entirely).
if [ "${MERGE_SKIP_POST_MERGE_TEST_GATE:-}" = "1" ]; then
  log "post-merge test floor: skipped (MERGE_SKIP_POST_MERGE_TEST_GATE=1)"
else
  CHANGED_FOR_TEST_GATE=$(g diff --name-only "$ORIGIN_BASE_SHA" HEAD 2>/dev/null || true)
  if [ -n "$(echo "$CHANGED_FOR_TEST_GATE" | tr -d '[:space:]')" ] && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/merge-post-merge-test-gate.js" ]; then
    log "post-merge test floor: checking scripts/lib/ colocated tests against the merged tree"
    if ! echo "$CHANGED_FOR_TEST_GATE" | (cd "$MAIN_DIR" && MERGE_TEST_GATE_BASELINE_SHA="$ORIGIN_BASE_SHA" node "$SCRIPT_DIR/lib/merge-post-merge-test-gate.js"); then
      restore_stash
      die "post-merge test floor failed — the MERGED tree has a NEW-since-origin/main scripts/lib/ colocated test failure (likely a semantic collision between two branches, see task #1149/#1433). Resolve in $MAIN_DIR, commit the fix, then re-run this script. (Escape hatches: MERGE_TEST_GATE_SKIP_BASELINE=1 to fall back to old all-or-nothing if the baseline diff itself misbehaves, or MERGE_SKIP_POST_MERGE_TEST_GATE=1 for the whole gate — scripts/merge-worktree-to-main.sh)"
    fi
  fi
fi

# --- Push, integrating remote moves via merge (never rebase) on rejection ---
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — skipping push"
else
  PUSHED=0
  for attempt in 1 2 3 4 5; do
    OUT=$(g push origin "$DEFAULT_BRANCH" 2>&1)
    # Authoritative success check: is local HEAD now an ancestor of origin? NEVER
    # grep the push output for "main -> main" — the REJECTION line ("! [rejected]
    # main -> main (fetch first)") contains that exact string and falsely reads as
    # success. The ancestor check is ground truth. (2026-06-21: the grep version
    # silently "succeeded" while Phase 2 never reached origin.)
    # Only trust the ancestor check against a FRESHLY-fetched ref. If the fetch
    # itself fails, the remote-tracking ref is stale and the ancestor test would
    # falsely report failure on an otherwise-successful push — so retry the fetch
    # a few times before concluding anything.
    FETCHED=0
    for _fa in 1 2 3; do
      if g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null; then FETCHED=1; break; fi
      sleep 2
    done
    if [ "$FETCHED" = 1 ] && g merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
      PUSHED=1; break
    fi
    if echo "$OUT" | grep -qiE "could not resolve host|failed to connect|timed out" || [ "$FETCHED" = 0 ]; then
      restore_stash; die "GitHub unreachable (network) — re-run when connectivity returns. Local merge is intact."
    fi
    log "push rejected (attempt $attempt) — merging remote and retrying"
    g merge "origin/$DEFAULT_BRANCH" --no-edit >/dev/null 2>&1 || { restore_stash; die "could not merge remote changes on retry"; }
  done
  [ "$PUSHED" = 1 ] || { restore_stash; die "push failed after retries"; }
  log "pushed"
fi

restore_stash || die "push succeeded but the pre-merge stash left unresolved conflicts on non-auto-gen path(s) — check working tree in $MAIN_DIR and resolve manually"

# --- VERIFY the files actually landed on origin (the step the incident skipped) ---
if [ "${DRY_RUN:-0}" != "1" ] && [ $(( ${#VERIFY_FILES[@]} + ${#DELETED_FILES[@]} )) -gt 0 ]; then
  FETCHED=0
  for _fa in 1 2 3; do
    if g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null; then FETCHED=1; break; fi
    sleep 2
  done
  [ "$FETCHED" = 1 ] || die "could not fetch origin/$DEFAULT_BRANCH for verify — network issue, re-run when connectivity returns"

  # Existence-only (cat-file -e) proves a same-named file is present at the ref —
  # NOT that it's the content from the commit we just pushed. A concurrent
  # session's push can reset origin/$DEFAULT_BRANCH's tip to an EARLIER commit
  # between our push and this verify step, and an older copy of the same path
  # would still pass the loop below. Re-run the ancestor check (same pattern as
  # the push-retry loop above) against the freshly-fetched ref first — if our
  # HEAD isn't an ancestor of origin's current tip, the tip moved backward
  # under us and the per-file loop cannot be trusted. (card #546, 2026-07-26:
  # this printed ✓✓ for both files while the actual fix content was absent.)
  g merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null \
    || die "HEAD is not an ancestor of origin/$DEFAULT_BRANCH — origin's tip moved (concurrent session?) since our push; per-file verify would be unreliable"

  # `${arr[@]+"${arr[@]}"}` — NOT a bare `"${arr[@]}"`. Under `set -u` (line 24)
  # bash 3.2, the stock /usr/bin/bash on macOS, treats an empty array expansion
  # as an unbound variable and aborts. Since the guard above admits this block
  # when EITHER list is non-empty, the other one is routinely empty: a
  # pure-deletion merge leaves VERIFY_FILES empty, and an explicit
  # `-- file...` caller list leaves DELETED_FILES empty. Aborting here would be
  # worse than the false alarm this all replaced — it happens AFTER a successful
  # push, so the delayed #668 re-verify below never gets scheduled. Same idiom
  # and same reason as scripts/lib/push-with-retry.sh:737 and scripts/hooks/pre-push:53.
  VERIFY_FAIL=0
  echo "── verifying on origin/$DEFAULT_BRANCH ──"
  for f in ${VERIFY_FILES[@]+"${VERIFY_FILES[@]}"}; do
    if g cat-file -e "origin/$DEFAULT_BRANCH:$f" 2>/dev/null; then
      echo "  ✓ $f"
    else
      echo "  ✗ MISSING: $f"; VERIFY_FAIL=1
    fi
  done
  for f in ${DELETED_FILES[@]+"${DELETED_FILES[@]}"}; do
    if g cat-file -e "origin/$DEFAULT_BRANCH:$f" 2>/dev/null; then
      echo "  ✗ STILL PRESENT (deletion did not land): $f"; VERIFY_FAIL=1
    else
      echo "  ✓ deleted: $f"
    fi
  done
  [ "$VERIFY_FAIL" = 0 ] || die "origin/$DEFAULT_BRANCH does not match what we pushed — a file we added is absent, or a file we deleted is still there"
fi

# --- Schedule a delayed re-verify (task #668) ────────────────────────────────
# The verify block above proves the push landed at THIS INSTANT — it cannot
# see a race that resolves after this script exits. #668's incident: this
# exact verify passed (files ✓✓, ancestor check green), then ~10-15 min later
# the merge commit was gone from origin (confirmed via GitHub's contents API,
# not local git — local git state proved unreliable mid-incident). Fire a
# detached background check that re-confirms via the GitHub compare API at
# +2m/+8m/+15m and self-dispatches an alert card if the commit falls off —
# doesn't block this script's exit, doesn't require the caller to babysit it.
if [ "${DRY_RUN:-0}" != "1" ]; then
  MERGE_SHA="$(g rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$MERGE_SHA" ] && command -v node >/dev/null 2>&1; then
    VERIFY_LOG="$MAIN_DIR/data/audit/verify-merge-landed.log"
    mkdir -p "$(dirname "$VERIFY_LOG")" 2>/dev/null || true
    (
      cd "$MAIN_DIR" 2>/dev/null || exit 0
      nohup node scripts/verify-merge-landed.js \
        --sha="$MERGE_SHA" --branch="$DEFAULT_BRANCH" \
        --label="$BRANCH -> $DEFAULT_BRANCH" \
        --delays=120,480,900 </dev/null >>"$VERIFY_LOG" 2>&1 &
    )
    log "delayed re-verify scheduled (+2m/+8m/+15m against $MERGE_SHA) — log: $VERIFY_LOG"
  fi
fi

# --- VERIFY the CONTENT survived, not just the filenames (card 3b1637c5) ─────
# The existence loop above (cat-file -e) proves a same-named file is present on
# origin — it CANNOT prove that file still holds the lines this merge pushed. A
# concurrent session whose merge reverts our hunks while leaving the path in
# place satisfies every check above: our merge commit really IS an ancestor of
# origin's tip, and the file really DOES exist. Task #684's T12 fix was dropped
# from origin exactly this way TWICE (2026-08-01 and 2026-08-02), each time
# after this script reported "verified on origin"; both drops were caught only
# by a human running `git show origin/$DEFAULT_BRANCH:<file> | grep`.
#
# scripts/lib/push-with-retry.sh:640 already defends ITS push path with
# scripts/lib/push-content-survival.js — this path never called it, so every
# modification-only merge (no files added, none deleted) shipped with zero
# content verification. Reuse the same helper and the same kill switch, so a
# false-positive storm can be silenced without a code revert.
#
# Deliberately placed AFTER the #668 delayed re-verify above, not before: die()
# here exits the script, and scheduling that background watcher first means a
# detected revert still gets its +2m/+8m/+15m follow-up instead of losing it.
#
# SCOPE — anchored to the BRANCH, not to $ORIGIN_BASE_SHA (adversarial-review
# finding). $ORIGIN_BASE_SHA..HEAD would also cover every file that only OTHER
# sessions touched (we merge origin before pushing, so their commits ride along
# in HEAD); with ~80 concurrent sessions on this main, "someone else changed
# that file too" is the common case, not an edge case, and the check would fire
# constantly on files that were never ours. Anchoring to the branch's own
# merge-base makes the comparison exactly:
#   base   = merge-base($BRANCH, $ORIGIN_BASE_SHA) — the file before OUR edits
#   before = $BRANCH tip — the content we intended to publish
#   final  = origin/$DEFAULT_BRANCH — what is actually live right now
# so only files this branch itself modified are examined. The trade: if the
# origin merge 3-way-combined someone else's edit into the same file, final
# matches neither base nor local and classifies as 'ambiguous' (not flagged) —
# a false negative we accept, because the incident this exists to catch (our
# lines gone, file back at its pre-edit content) still lands squarely on
# 'reverted'.
# Exit codes: 0 = nothing reverted, 1 = a file REVERTED to its pre-merge content
# (hard failure), 2 = bad args / git failure (fail OPEN — same convention as the
# helper's other callers: a broken check must never fail an otherwise-good push).
if [ "${DRY_RUN:-0}" != "1" ] \
   && [ "${PUSH_SKIP_CONTENT_SURVIVAL_CHECK:-}" != "1" ] \
   && command -v node >/dev/null 2>&1 \
   && [ -f "$SCRIPT_DIR/lib/push-content-survival.js" ]; then
  # The existence block only fetches when VERIFY_FILES/DELETED_FILES is
  # non-empty, so re-fetch (bounded, best-effort) rather than trust a
  # possibly-stale tracking ref. Fail OPEN on the fetch itself — a network
  # hiccup here must not manufacture a failure on a push that already succeeded.
  for _fa in 1 2 3; do
    g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null && break
    sleep 2
  done
  # $CONTENT_FORK_BASE, NOT a merge-base recomputed here: by this point $BRANCH
  # has been merged into $DEFAULT_BRANCH and is very likely already on origin
  # (another session pushes our shared local main constantly), so any merge-base
  # taken now collapses to $BRANCH's own tip and the comparison goes vacuous.
  CS_BASE="${CONTENT_FORK_BASE:-}"
  CS_TIP="$(g rev-parse "$BRANCH" 2>/dev/null || true)"
  if [ -n "$CS_BASE" ] && [ -n "$CS_TIP" ]; then
    echo "── content-survival check vs origin/$DEFAULT_BRANCH ──"
    # `cd || exit 2` inside the subshell, NOT `cd &&`: push-content-survival.js
    # shells out to plain `git` in the CWD (it has no -C equivalent), and a
    # failed cd must land on the fail-OPEN code (2), never on the REVERTED
    # code (1) that aborts the script.
    CS_OUT="$(cd "$MAIN_DIR" 2>/dev/null || exit 2; node "$SCRIPT_DIR/lib/push-content-survival.js" \
      --before-sha="$CS_TIP" \
      --base-sha="$CS_BASE" \
      --check-ref="origin/$DEFAULT_BRANCH" 2>&1)"
    CS_RC=$?
    [ -n "$CS_OUT" ] && echo "$CS_OUT"
    # A guard that compares nothing must not read as a guard that passed — that
    # is the exact vacuous-guard shape as #766/#782. If the helper found no
    # modified files while this run is verifying files on origin, say so.
    case "$CS_OUT" in
      *"no modified files to check"*|*"SKIP"*)
        if [ ${#VERIFY_FILES[@]} -gt 0 ]; then
          echo "  ⚠ content-survival compared NOTHING (fork base $CS_BASE .. $BRANCH is empty)" >&2
          echo "    while ${#VERIFY_FILES[@]} file(s) were verified present. Those files' CONTENT is" >&2
          echo "    UNVERIFIED on this run — check by hand:" >&2
          echo "      git -C $MAIN_DIR show origin/$DEFAULT_BRANCH:<file>" >&2
        fi
        ;;
    esac
    if [ "$CS_RC" = 1 ]; then
      # Recovery guidance matters here and is easy to get wrong: re-running
      # this script does NOT restore the content. $BRANCH is already merged
      # into $DEFAULT_BRANCH, so `git merge $BRANCH` is a no-op, the outgoing
      # diff is empty, and the re-run would exit 0 with the lines still gone.
      # The content has to be re-applied on top of the reverting commit.
      echo "" >&2
      echo "  Recovery (re-running this script will NOT help — $BRANCH is already merged," >&2
      echo "  so the merge is a no-op and the revert is the NEWER commit):" >&2
      echo "    1. find the reverting commit:  git -C $MAIN_DIR log --oneline -5 origin/$DEFAULT_BRANCH -- <file>" >&2
      echo "    2. re-apply our version:       git -C $MAIN_DIR checkout $BRANCH -- <file>" >&2
      echo "    3. commit + push that, then tell the other session's owner what reverted it." >&2
      die "origin/$DEFAULT_BRANCH REVERTED content this merge pushed (see above) — the push landed but the lines are GONE."
    fi
  fi
fi

echo "✅ $BRANCH integrated into $DEFAULT_BRANCH and verified on origin."
