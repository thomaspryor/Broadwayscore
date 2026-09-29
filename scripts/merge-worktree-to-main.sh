#!/usr/bin/env bash
#
# merge-worktree-to-main.sh — land a worktree branch on origin/main.
#
# DEFAULT (BRO-3873 step 4 / BRO-3425): the session's landing script is a THIN
# client of .github/workflows/land.yml. It never touches the shared main
# checkout beyond read-only object-store queries:
#     1. local pre-flight floors on the BRANCH tree (node --check on changed
#        scripts, the scripts/lib colocated-test floor vs the fork point);
#        the push audits + tsc run in scripts/hooks/pre-push on the push below,
#     2. `git push origin <tip>:refs/heads/land/<branch>`,
#     3. wait for land.yml (scripts/lib/wait-for-run.sh — one API call per
#        ≥60s, quota-aware, 45 min cap; falls back to `git ls-remote` polling
#        when gh is unavailable) — land.yml runs the delta-vs-base gates on
#        the REBASED tree, fast-forwards main under the serialized `landing`
#        group, verifies ancestry and deletes the land/** ref,
#     4. prove it locally (ancestor or patch-equivalent on a fresh
#        origin/main), run the content-survival check, print
#          LANDED: <branch> → <sha> in <s>s via land/<branch> (<run-url>)
#        or, on a red gate,
#          REFUSED: <branch> — land run <conclusion> at gate '<name>' (<run-url>)
#          with the alert conditionKey land:land/<branch>            (exit 1)
#        or, after 45 min without a verdict, TIMEOUT + run URL         (exit 2).
#   Sessions land via land/**; bots (workflows, launchd daemons) keep pushing
#   main directly through scripts/lib/push-with-retry.sh — that is deliberate.
#
# STALENESS GUARD (reviewer P0): at startup this file compares itself with
#   origin/main's copy; if they differ (a worktree branched before a change
#   to this script), or this is a detached copy with no scripts/lib beside
#   it, it materialises origin/main's scripts/ into a temp dir and re-execs
#   that copy with the same args. Decision: scripts/lib/merge-script-staleness.sh.
#   Opt out: MERGE_SCRIPT_NO_REEXEC=1. Marker: MERGE_SCRIPT_STALENESS_GUARD.
#
# LEGACY (rollback only): LAND_LEGACY_DIRECT=1 restores the pre-step-4 flow —
#   merge origin into the SHARED main checkout, merge the branch, push main
#   directly with merge-based retry, verify — with a loud deprecation line.
#   Its history and hazards: `git pull --rebase` silently drops merge commits
#   (2026-06-21), the data-daemon dirties the shared checkout mid-merge,
#   concurrent sessions reset each other's local main (#546/#668/#677).
#   Before switching a fleet back to it, drain the queue first — cancel the
#   in-flight land.yml runs and delete pending land/** refs (`gh run list
#   --workflow=land.yml --status=in_progress`, `gh api -X DELETE
#   repos/thomaspryor/Broadwayscore/git/refs/heads/land/<b>`) — or two
#   writers (land.yml's fast-forward and the legacy direct push) race.
#
# ROLLBACK FLAGS (all three documented here on purpose — one place):
#   LAND_LEGACY_DIRECT=1   this script: legacy direct merge+push (logged by the
#                          pre-push hook as direct-push-allowed)
#   LAND_ENFORCE_OFF=1     scripts/hooks/pre-push + the ~/.claude PreToolUse
#                          gate: allow a session's direct push to main (logged)
#   DIRECT_PUSH_DETECT_OFF repo VARIABLE =1: disables
#                          .github/workflows/check-direct-push-to-main.yml
#                          (the digest for main shas with no landings.jsonl row)
#
# USAGE
#   scripts/merge-worktree-to-main.sh [branch] [-- file1 file2 ...]
#     branch   worktree branch to land (default: current branch)
#     files    paths that MUST exist on origin/main after landing
#              (default: the files the branch changed vs main)
#   DRY_RUN=1 scripts/merge-worktree-to-main.sh   # floors only, no push
#   LAND_WAIT_MIN=45                              # land.yml wait cap
#
# RESUME CONTRACT: every run is idempotent. land.yml takes 10-22 min and the
#   Claude Bash tool caps one command at 10 min, so from a session run it as
#   `LAND_WAIT_MIN=9 bash scripts/merge-worktree-to-main.sh` (Bash timeout
#   600000) and simply RE-RUN on TIMEOUT: an already-landed tip prints LANDED
#   at once (ancestor, patch-equivalent, or a landings.jsonl row naming the
#   tip); a land/<branch> ref already at the tip is not re-pushed, the wait
#   just continues. A REFUSED verdict is final until the branch changes.
#
# The landing actor itself is scripts/lib/land-branch.js (BRO-3873 step 2),
# run by land.yml; scripts/land.js is its CLI.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# ── MERGE_SCRIPT_STALENESS_GUARD (BRO-3873 step 4, reviewer P0) ──────────────
# Bump MERGE_SCRIPT_VERSION whenever the landing behaviour changes. A copy
# whose version is LOWER than origin/main's re-execs origin/main's copy; a
# copy without the line is version 0. Compared by version, not bytes, so
# the branch that ships a newer script never defers to the older origin
# copy (2026-09-20: a byte-compare did exactly that and the old copy merged
# the WIP branch into the shared main checkout).
MERGE_SCRIPT_VERSION=2
# Runs BEFORE any lib is sourced: a detached copy (`git show origin/main:… >
# /tmp/x.sh && bash /tmp/x.sh`) has no scripts/lib beside it, and an old
# worktree's copy may lack libs a newer version needs — so the re-exec
# materialises origin/main's whole scripts/ tree, not just this file.
# The repo whose origin/main we compare against: this file's own checkout
# first (a worktree's copy compares against ITS origin), the cwd's only for
# a detached copy that has no checkout of its own.
_mss_repo="$(git -C "${SCRIPT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$_mss_repo" ] && [ "${MERGE_SCRIPT_REEXECED:-}" != "1" ] && [ "${MERGE_SCRIPT_NO_REEXEC:-}" != "1" ]; then
  _mss_tmp="$(mktemp -d "${TMPDIR:-/tmp}/land-script.XXXXXX")"
  _mss_origin="$_mss_tmp/origin-copy.sh"
  # Bounded, best-effort refresh of origin/main (offline → cached ref).
  if command -v timeout >/dev/null 2>&1; then timeout 30 git -C "$_mss_repo" fetch origin main -q 2>/dev/null || true
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout 30 git -C "$_mss_repo" fetch origin main -q 2>/dev/null || true
  else git -C "$_mss_repo" fetch origin main -q 2>/dev/null || true; fi
  git -C "$_mss_repo" show origin/main:scripts/merge-worktree-to-main.sh > "$_mss_origin" 2>/dev/null || : > "$_mss_origin"
  # The decision lib: ours when it is beside us, else origin/main's (a
  # detached copy has no lib dir at all) — never an inline re-statement.
  _mss_lib="$SCRIPT_DIR/lib/merge-script-staleness.sh"
  if [ ! -f "$_mss_lib" ]; then
    _mss_lib="$_mss_tmp/merge-script-staleness.sh"
    git -C "$_mss_repo" show origin/main:scripts/lib/merge-script-staleness.sh > "$_mss_lib" 2>/dev/null || : > "$_mss_lib"
  fi
  if [ -s "$_mss_lib" ]; then
    # shellcheck source=scripts/lib/merge-script-staleness.sh
    source "$_mss_lib"
    _mss_decision=$(merge_script_staleness_decision "${BASH_SOURCE[0]}" "$_mss_origin" "$SCRIPT_DIR/lib")
  else
    _mss_decision="skip:no-origin-copy"
  fi
  if [ "$_mss_decision" = "skip:origin-older" ] && [ ! -d "$SCRIPT_DIR/lib" ]; then
    echo "❌ merge script: this is a detached copy (no scripts/lib beside it) and origin/main's copy is older than it — run it from a checkout instead: bash scripts/merge-worktree-to-main.sh" >&2
    exit 1
  fi
  if [ "$_mss_decision" = "reexec" ]; then
    if git -C "$_mss_repo" archive origin/main scripts/merge-worktree-to-main.sh scripts/lib 2>/dev/null | tar -x -C "$_mss_tmp" 2>/dev/null \
       && [ -f "$_mss_tmp/scripts/merge-worktree-to-main.sh" ]; then
      echo "→ merge script: origin/main's copy is newer (MERGE_SCRIPT_VERSION $(merge_script_version "${BASH_SOURCE[0]}") → $(merge_script_version "$_mss_origin")) or this copy runs detached — re-exec'ing origin/main's copy (BRO-3425; MERGE_SCRIPT_NO_REEXEC=1 to disable)" >&2
      export MERGE_SCRIPT_REEXECED=1 MERGE_SCRIPT_REEXEC_TMP="$_mss_tmp"
      exec bash "$_mss_tmp/scripts/merge-worktree-to-main.sh" "$@"
    fi
    echo "⚠ merge script: could not materialise origin/main's scripts/ — continuing with this copy" >&2
  fi
  rm -rf "$_mss_tmp" 2>/dev/null || true
  unset _mss_tmp _mss_origin _mss_decision _mss_lib
fi
unset _mss_repo
# The re-exec'd copy removes its own temp tree on exit (the legacy path's
# EXIT trap below re-installs this alongside push_mutex_release).
_mss_cleanup() { [ -n "${MERGE_SCRIPT_REEXEC_TMP:-}" ] && rm -rf "$MERGE_SCRIPT_REEXEC_TMP" 2>/dev/null; return 0; }
trap '_mss_cleanup' EXIT

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
VERIFY_FILES_EXPLICIT=0; [ ${#VERIFY_FILES[@]} -gt 0 ] && VERIFY_FILES_EXPLICIT=1

# --- Locate the main worktree (first entry of `git worktree list`) ---
MAIN_DIR=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[ -n "$MAIN_DIR" ] && [ -d "$MAIN_DIR" ] || die "could not locate main worktree via 'git worktree list'"
g() { git -C "$MAIN_DIR" "$@"; }

# is_landed <sha> <ref> — shallow-aware replacement for raw
# `git merge-base --is-ancestor <sha> <ref>` (task #1489). A shallow shared
# checkout makes the raw form silently answer "not an ancestor" for commits
# that genuinely landed once the graph is truncated past them — this wraps
# scripts/lib/landing-verify.js, which restores full history first (or
# reports UNKNOWN, never a false NOT_LANDED) instead of trusting a
# potentially-truncated graph. Exit codes: 0=LANDED 1=NOT_LANDED 2=UNKNOWN.
# Falls back to the raw check (0/1 only) if node or the lib file is missing.
is_landed() {
  local sha="$1" branch="$2"
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/landing-verify.js" ]; then
    node "$SCRIPT_DIR/lib/landing-verify.js" --sha="$sha" --branch="$branch" --cwd="$MAIN_DIR" >/dev/null 2>&1
    return $?
  fi
  g merge-base --is-ancestor "$sha" "origin/$branch" 2>/dev/null
}

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

# verify_files_on_origin — the per-file existence/absence proof both paths
# share (the incident this script was born from: "pushed" with the work
# missing from origin). Reads a FRESHLY fetched origin/$DEFAULT_BRANCH.
verify_files_on_origin() {
  local f fail=0
  echo "── verifying on origin/$DEFAULT_BRANCH ──"
  for f in ${VERIFY_FILES[@]+"${VERIFY_FILES[@]}"}; do
    if g cat-file -e "origin/$DEFAULT_BRANCH:$f" 2>/dev/null; then echo "  ✓ $f"; else echo "  ✗ MISSING: $f"; fail=1; fi
  done
  for f in ${DELETED_FILES[@]+"${DELETED_FILES[@]}"}; do
    if g cat-file -e "origin/$DEFAULT_BRANCH:$f" 2>/dev/null; then echo "  ✗ STILL PRESENT (deletion did not land): $f"; fail=1; else echo "  ✓ deleted: $f"; fi
  done
  return $fail
}

# prove_and_finish <tip> <fork> <landed_sha> <proof> <land_name> <run_url> <t0>
# The ONE completion path for every "it landed" outcome — first completion,
# resume after TIMEOUT, already-an-ancestor — so none of them can skip the
# per-file existence proof, the content-survival check, or the delayed
# re-verify (Codex ship-check finding: an early resume exit printed LANDED
# for a landing that a later commit had reverted). Reads a freshly fetched
# origin/$DEFAULT_BRANCH; exits 0 on success, dies otherwise.
prove_and_finish() {
  local tip="$1" fork="$2" landed_sha="$3" proof="$4" land_name="$5" run_url="$6" t0="$7"
  g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || true
  if [ $(( ${#VERIFY_FILES[@]} + ${#DELETED_FILES[@]} )) -gt 0 ]; then
    verify_files_on_origin || die "origin/$DEFAULT_BRANCH does not match what landed — a file we added is absent, or a file we deleted is still there"
  fi
  if [ "${PUSH_SKIP_CONTENT_SURVIVAL_CHECK:-}" != "1" ] && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/push-content-survival.js" ] && [ -n "$fork" ]; then
    echo "── content-survival check vs origin/$DEFAULT_BRANCH ──"
    local cs_out cs_rc
    cs_out="$(cd "$MAIN_DIR" 2>/dev/null || exit 2; node "$SCRIPT_DIR/lib/push-content-survival.js" --before-sha="$tip" --base-sha="$fork" --check-ref="origin/$DEFAULT_BRANCH" 2>&1)"; cs_rc=$?
    [ -n "$cs_out" ] && echo "$cs_out"
    [ "$cs_rc" != 1 ] || die "origin/$DEFAULT_BRANCH REVERTED content this landing pushed (see above) — re-apply on top of the reverting commit"
  fi
  if [ -n "$landed_sha" ] && command -v node >/dev/null 2>&1 && [ -f "$MAIN_DIR/scripts/verify-merge-landed.js" ]; then
    local vlog="$MAIN_DIR/data/audit/verify-merge-landed.log"
    mkdir -p "$(dirname "$vlog")" 2>/dev/null || true
    ( cd "$MAIN_DIR" 2>/dev/null || exit 0
      nohup node scripts/verify-merge-landed.js --sha="$landed_sha" --branch="$DEFAULT_BRANCH" --label="$BRANCH -> $DEFAULT_BRANCH (land/**)" --delays=120,480,900 </dev/null >>"$vlog" 2>&1 & )
    log "delayed re-verify scheduled (+2m/+8m/+15m against ${landed_sha:0:10}) — log: $vlog"
  fi
  echo "LANDED: $BRANCH → ${landed_sha:-<rebased; sha in data/audit/landings.jsonl once its row lands>} in $(( $(date +%s) - t0 ))s${land_name:+ via $land_name}${run_url:+ ($run_url)} [proof: $proof]"
  exit 0
}

# ══ DEFAULT PATH (BRO-3873 step 4): land via land/<branch> + land.yml ════════
# Never checks out, merges into, or stashes on $MAIN_DIR. The `g` calls in
# here read the shared object store / remote-tracking refs; the only writes
# are `g fetch` (ref updates) and the delayed re-verify's append to
# data/audit/verify-merge-landed.log — both exactly as the legacy path did.
# Run it FROM YOUR WORKTREE: given a branch name from elsewhere, the floors
# are skipped and the land/** push is made from $MAIN_DIR's object store
# (so scripts/hooks/pre-push's tsc, if it fires, sees main's tree).
land_via_landing_branch() {
  local t0 tip fork src_dir cwd_top cwd_head land_name push_dir changed
  t0=$(date +%s)
  tip=$(g rev-parse "$BRANCH" 2>/dev/null) || die "cannot resolve $BRANCH"

  g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || log "  ⚠ fetch failed (offline?) — continuing with cached origin/$DEFAULT_BRANCH"
  land_name="$BRANCH"
  case "$land_name" in land/*) ;; *) land_name="land/$BRANCH" ;; esac
  # ── resume contract ───────────────────────────────────────────────────────
  # Every run is idempotent, so a wait cut short (the Claude Bash tool caps a
  # command at 10 min; land.yml takes 10-22 min) is resumed by simply
  # re-running: already landed → LANDED at once (ancestor, or the rebased
  # patches are on origin/main / a landings.jsonl row names this tip);
  # land/<branch> already at this tip → no re-push, just wait again.
  fork=$(g merge-base "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null || true)
  [ -n "$fork" ] || die "no merge-base between origin/$DEFAULT_BRANCH and $BRANCH"
  # The default verify list above is anchored on the shared checkout's LOCAL
  # main, which sessions no longer advance — re-anchor on origin's fork point
  # (live c1 probe: 152 "files to verify" for a one-line branch).
  if [ "$VERIFY_FILES_EXPLICIT" = 0 ]; then
    VERIFY_FILES=(); DELETED_FILES=()
    while IFS= read -r f; do [ -n "$f" ] && VERIFY_FILES+=("$f"); done < <(g diff --name-only --diff-filter=d "$fork" "$tip" 2>/dev/null)
    while IFS= read -r f; do [ -n "$f" ] && DELETED_FILES+=("$f"); done < <(g diff --name-only --no-renames --diff-filter=D "$fork" "$tip" 2>/dev/null)
    log "will verify ${#VERIFY_FILES[@]} file(s) present + ${#DELETED_FILES[@]} deleted on origin after landing (vs origin fork ${fork:0:10})"
  fi
  local prior_sha=""
  prior_sha=$(g show "origin/$DEFAULT_BRANCH:data/audit/landings.jsonl" 2>/dev/null | grep -F "\"tip\":\"$tip\"" | tail -1 | sed -E 's/.*"sha":"([0-9a-f]{40})".*/\1/')
  if is_landed "$tip" "$DEFAULT_BRANCH"; then
    prove_and_finish "$tip" "$fork" "$tip" "ancestor" "" "" "$t0"   # exits
  fi
  if [ -n "$prior_sha" ] || { [ -n "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null)" ] && [ -z "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null | grep '^+')" ]; }; then
    # Landed by an earlier run (resume after TIMEOUT, or a re-run). The SAME
    # proofs as a first completion run here — a landing that was since
    # reverted must not read as success (Codex ship-check finding).
    local prior_proof="patch-equivalent (rebased by land.yml)"
    [ -n "$prior_sha" ] && prior_proof="landings.jsonl row for this tip"
    prove_and_finish "$tip" "$fork" "$prior_sha" "$prior_proof" "$land_name" "" "$t0"
  fi
  changed=$(g diff --name-only --diff-filter=d "$fork" "$tip" 2>/dev/null || true)

  # ── local pre-flight floors, on the BRANCH tree ────────────────────────────
  # The tree we floor-check is the checkout this was run from, when its HEAD
  # is the branch tip (the normal "run it from your worktree" case). Run from
  # elsewhere (branch given by name), the floors are skipped with a note —
  # land.yml's gauntlet on the rebased tree is the gate that decides anyway.
  src_dir=""
  cwd_top=$(git rev-parse --show-toplevel 2>/dev/null || true)
  cwd_head=$(git rev-parse HEAD 2>/dev/null || true)
  [ -n "$cwd_top" ] && [ "$cwd_head" = "$tip" ] && src_dir="$cwd_top"
  if [ -z "$src_dir" ]; then
    log "pre-flight floors: skipped (cwd is not a checkout of $BRANCH's tip) — land.yml runs the full gauntlet"
  else
    local f err syntax_fail=0
    while IFS= read -r f; do
      case "$f" in scripts/*.js|scripts/*.mjs|scripts/*.cjs) ;; *) continue ;; esac
      [ -f "$src_dir/$f" ] || continue
      if ! err=$(node --check "$src_dir/$f" 2>&1); then
        echo "  ✗ $f" >&2; echo "$err" | sed 's/^/      /' >&2; syntax_fail=1
      fi
    done <<< "$changed"
    [ "$syntax_fail" = 0 ] || die "pre-flight syntax floor failed on $BRANCH (node --check) — fix, commit, re-run"
    if [ "${MERGE_SKIP_POST_MERGE_TEST_GATE:-}" = "1" ]; then
      log "colocated test floor: skipped (MERGE_SKIP_POST_MERGE_TEST_GATE=1)"
    elif [ ! -f "$src_dir/data/shows.json" ] || [ ! -f "$src_dir/data/reviews.json" ]; then
      # DATA GUARD — same rule as scripts/hooks/pre-push's tsc step: a bare
      # worktree has no data/*.json symlinks, and a dozen scripts/lib tests
      # read them, so the floor would report data-absent failures as "new"
      # (measured 2026-09-20: 12 false NEW failures in this exact spot).
      # land.yml's gauntlet checks out core data and runs the same batch.
      log "colocated test floor: skipped (data/shows.json + reviews.json absent — bare worktree; land.yml runs the scripts/lib batch with core data)"
    elif [ -n "$(echo "$changed" | tr -d '[:space:]')" ] && command -v node >/dev/null 2>&1; then
      local gate="$SCRIPT_DIR/lib/merge-post-merge-test-gate.js"
      [ -f "$gate" ] || gate="$src_dir/scripts/lib/merge-post-merge-test-gate.js"
      if [ -f "$gate" ]; then
        log "colocated test floor: scripts/lib/*.test.mjs on $BRANCH's tree vs fork point ${fork:0:10} (scripts/lib/merge-post-merge-test-gate.js)"
        if ! echo "$changed" | (cd "$src_dir" && MERGE_TEST_GATE_BASELINE_SHA="$fork" node "$gate"); then
          die "colocated test floor failed on $BRANCH — see the gate's own 'post-merge test floor: FAILED (...)' line above (MERGE_SKIP_POST_MERGE_TEST_GATE=1 to bypass)"
        fi
      fi
    fi
    log "push audits + tsc: run by scripts/hooks/pre-push on the land/** push below (range ${fork:0:10}..${tip:0:10})"
  fi

  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "DRY_RUN=1 — floors done; would push ${tip:0:10} → origin/$land_name for land.yml. Nothing pushed."
    exit 0
  fi

  # ── push the tip to land/<branch> (skipped on resume: ref already there) ──
  push_dir="${src_dir:-$MAIN_DIR}"
  local pout remote_land
  remote_land=$(git -C "$push_dir" ls-remote --heads origin "$land_name" 2>/dev/null | awk '{print $1}')
  if [ "$remote_land" = "$tip" ]; then
    log "origin/$land_name is already at ${tip:0:10} — resuming the wait for land.yml (no re-push)"
  elif ! pout=$(git -C "$push_dir" push origin "$tip:refs/heads/$land_name" 2>&1); then
    if echo "$pout" | grep -qiE 'non-fast-forward|fetch first|\[rejected\]'; then
      log "  origin/$land_name exists from an earlier attempt — replacing it"
      pout=$(git -C "$push_dir" push --force origin "$tip:refs/heads/$land_name" 2>&1) || { echo "$pout" >&2; die "push to $land_name failed"; }
    else
      echo "$pout" >&2; die "push to $land_name failed (the pre-push hook's audits run here — fix on $BRANCH and re-run)"
    fi
  else
    log "pushed ${tip:0:10} → origin/$land_name (land.yml takes it from here)"
  fi

  # ── wait for land.yml ─────────────────────────────────────────────────────
  local run_id="" run_url="" poll_rc wait_min="${LAND_WAIT_MIN:-45}" wait_sh
  wait_sh="$SCRIPT_DIR/lib/wait-for-run.sh"; [ -f "$wait_sh" ] || wait_sh="$MAIN_DIR/scripts/lib/wait-for-run.sh"
  if command -v gh >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    local _i run_json
    for _i in 1 2 3 4 5 6; do
      run_json=$(cd "$push_dir" && gh run list --workflow=land.yml --branch="$land_name" --json databaseId,headSha,url --limit 5 2>/dev/null || true)
      read -r run_id run_url < <(RJ="$run_json" TIP="$tip" node -e '
        let rows = []; try { rows = JSON.parse(process.env.RJ || "[]"); } catch {}
        const r = rows.find(x => x.headSha === process.env.TIP);
        if (r) console.log(`${r.databaseId} ${r.url}`); else console.log("");' 2>/dev/null)
      [ -n "$run_id" ] && break
      sleep 20
    done
  fi
  if [ -n "$run_id" ] && [ -f "$wait_sh" ]; then
    log "land run $run_url — waiting (wait-for-run.sh: one API call per ≥60s, ${wait_min} min cap)"
    (cd "$push_dir" && bash "$wait_sh" "$run_id" "$wait_min"); poll_rc=$?
  else
    log "no land.yml run visible for ${tip:0:10} (gh unavailable, or the listing lagged) — polling refs/heads/$land_name via git ls-remote every 60s (${wait_min} min cap; land.yml deletes it only after ancestry is verified)"
    local deadline; deadline=$(( $(date +%s) + wait_min * 60 )); poll_rc=2
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if ! git -C "$push_dir" ls-remote --exit-code --heads origin "$land_name" >/dev/null 2>&1; then poll_rc=0; break; fi
      sleep 60
    done
  fi

  case "$poll_rc" in
    0)
      local landed_sha="" proof="" _t
      for _t in 1 2 3 4 5; do
        g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || true
        landed_sha=$(g show "origin/$DEFAULT_BRANCH:data/audit/landings.jsonl" 2>/dev/null | grep -F "\"tip\":\"$tip\"" | tail -1 | sed -E 's/.*"sha":"([0-9a-f]{40})".*/\1/')
        [ -n "$landed_sha" ] && break
        sleep 30   # the landings.jsonl row is committed by land.yml a step after the push
      done
      if is_landed "$tip" "$DEFAULT_BRANCH"; then
        proof="ancestor"; landed_sha="${landed_sha:-$tip}"
      elif [ -n "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null)" ] && [ -z "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null | grep '^+')" ]; then
        # non-empty AND no '+': an EMPTY cherry (merge-only branch, or a
        # failed cherry) is no evidence at all, never equivalence.
        proof="patch-equivalent (rebased by land.yml)"
      else
        die "land run reported success but ${tip:0:10}'s commits are on origin/$DEFAULT_BRANCH neither as ancestors nor as equivalent patches — inspect ${run_url:-the land.yml run} before assuming anything landed"
      fi
      prove_and_finish "$tip" "$fork" "$landed_sha" "$proof" "$land_name" "$run_url" "$t0"   # exits
      ;;
    1)
      # A red run is not proof nothing landed: land.yml can go red AFTER its
      # fast-forward (ancestry UNKNOWN, a ledger step throwing). Check the
      # landing itself before claiming REFUSED (ship-check finding).
      g fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || true
      local late_sha=""
      late_sha=$(g show "origin/$DEFAULT_BRANCH:data/audit/landings.jsonl" 2>/dev/null | grep -F "\"tip\":\"$tip\"" | tail -1 | sed -E 's/.*"sha":"([0-9a-f]{40})".*/\1/')
      if is_landed "$tip" "$DEFAULT_BRANCH"; then
        log "land run went red but ${tip:0:10} IS on origin/$DEFAULT_BRANCH — treating as landed; inspect ${run_url:-the run} for the red step"
        prove_and_finish "$tip" "$fork" "$tip" "ancestor (run red after the push)" "$land_name" "$run_url" "$t0"
      elif [ -n "$late_sha" ] || { [ -n "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null)" ] && [ -z "$(g cherry "origin/$DEFAULT_BRANCH" "$tip" 2>/dev/null | grep '^+')" ]; }; then
        log "land run went red but ${tip:0:10}'s patches ARE on origin/$DEFAULT_BRANCH — treating as landed; inspect ${run_url:-the run} for the red step"
        prove_and_finish "$tip" "$fork" "$late_sha" "patch-equivalent (run red after the push)" "$land_name" "$run_url" "$t0"
      fi
      local conclusion="failure" gate="unknown"
      if [ -n "$run_id" ] && command -v gh >/dev/null 2>&1; then
        read -r conclusion gate < <(cd "$push_dir" && gh run view "$run_id" --json conclusion,jobs --jq '[.conclusion, ([.jobs[] | select(.conclusion=="failure") | .steps[] | select(.conclusion=="failure") | .name] | first // "unknown")] | join(" ")' 2>/dev/null || echo "failure unknown")
      fi
      echo "REFUSED: $BRANCH — land run $conclusion at gate '$gate'${run_url:+ ($run_url)}"
      echo "  alert conditionKey: land:$land_name (digest) — refs/heads/$land_name is left in place; nothing reached $DEFAULT_BRANCH."
      case "$conclusion" in
        cancelled) echo "  cancelled = superseded in the 'landing' concurrency group; re-run this script (an empty commit is fine) to land again." ;;
        *) echo "  Fix on $BRANCH, commit, and re-run this script (any push to $land_name re-runs the checks)." ;;
      esac
      exit 1
      ;;
    *)
      echo "TIMEOUT: $BRANCH — no land.yml verdict after ${wait_min} min${run_url:+ — run: $run_url}. origin/$land_name is in place; RE-RUN THIS SCRIPT TO RESUME (it will not re-push, and prints LANDED at once if the run finished meanwhile)."
      exit 2
      ;;
  esac
}

if [ "${LAND_LEGACY_DIRECT:-}" = "1" ]; then
  echo "⚠️  DEPRECATED (BRO-3425): LAND_LEGACY_DIRECT=1 — merging $BRANCH into the SHARED main checkout ($MAIN_DIR) and pushing $DEFAULT_BRANCH directly. Rollback-only; the default lands via land/** + land.yml. scripts/hooks/pre-push logs this as direct-push-allowed." >&2
else
  land_via_landing_branch
  exit 3   # unreachable — the function always exits
fi

# ══ LEGACY PATH (LAND_LEGACY_DIRECT=1 only) ══════════════════════════════════

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
trap 'push_mutex_release; _mss_cleanup' EXIT

# BRO-142 (generalized to REBASE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD by task
# #1558): refuse to touch $MAIN_DIR if it already has an in-progress-operation
# marker this run didn't create. Checked HERE — right after
# push_mutex_acquire, not before it — so there's no TOCTOU window: two
# concurrent invocations could both observe "none" if checked pre-mutex, then
# the loser (having already passed its own check) barrels into merging/pushing
# on top of the marker the winner's failed operation just left behind.
# Checking only once the mutex is actually HELD closes that gap for every
# mutex-protected caller (a manual, out-of-band `git merge`/`rebase`/etc.
# outside the scripted flow remains a documented residual gap — see detect-
# stale-merge-head.sh's header). die() already releases the mutex and the
# EXIT trap above is idempotent, so no duplicate cleanup is needed. This
# script never rebases/cherry-picks/reverts $MAIN_DIR itself (see the
# preserve-HEAD comments below), so unlike push-with-retry.sh there's no
# self-trigger risk from adding the extra marker types here.
# Guarded on the file existing (fail OPEN, not closed): a copy of this script
# running from a branch/checkout that predates this file must behave exactly
# as it always did, not spuriously refuse every merge because a dependency
# it's never heard of is missing (caught by this file's own test fixture,
# which — deliberately, matching push-mutex.sh/push-content-survival.js
# above — copies only named dependencies into an isolated fixture dir).
if [ -f "$SCRIPT_DIR/lib/detect-stale-merge-head.sh" ]; then
  # shellcheck source=scripts/lib/detect-stale-merge-head.sh
  source "$SCRIPT_DIR/lib/detect-stale-merge-head.sh"
  for _bro142_marker in ${STALE_MARKER_TYPES:-MERGE_HEAD}; do
    _bro142_result=$(marker_staleness "$MAIN_DIR" "$_bro142_marker")
    _bro142_status="${_bro142_result%% *}"
    if [ "$_bro142_status" != "none" ]; then
      die "existing $_bro142_marker in $MAIN_DIR — refusing to merge/push on top of it. $(marker_staleness_message "$MAIN_DIR" "$_bro142_marker" "$_bro142_status" "${_bro142_result#* }")"
    fi
  done
fi
unset _bro142_result _bro142_status _bro142_marker

# --- Stash any dirty tracked files (the data-daemon race) ---
# Factored into stash_if_dirty() (BRO-2552) so the push-retry loop far below
# can run this exact check again immediately before its own remote merge: the
# daemon has no cooldown and can re-dirty a tracked file (e.g.
# data/audit/stage-latency.jsonl) during the minutes-long test-suite/push-audit
# run that happens between this initial stash and a later retry attempt —
# which used to hard-fail that retry's merge with "local changes would be
# overwritten by merge" instead of stashing again (BRO-2540, 2026-08-30 — hit
# twice live in one session, each costing a full wasted test-suite re-run).
STASHED=0
stash_if_dirty() {
  if ! g diff --quiet 2>/dev/null || ! g diff --cached --quiet 2>/dev/null; then
    log "working tree dirty (likely the data daemon) — stashing"
    g stash push -m "wt-integ-$$" >/dev/null 2>&1 && STASHED=1
  fi
}
stash_if_dirty

# pop_stash_safely — pops exactly one stash (stash@{0}) with the conflict-
# safety rules below. Shared by restore_stash() (the top-of-script stash,
# popped at the very end) and the push-retry loop's own tightly-scoped
# re-stash (BRO-2552) — both need the identical safety net, not two copies
# that can drift apart. Captures the stash's SHA FRESH, right before
# attempting the pop, rather than trusting a value computed earlier: by the
# time this runs, index-based `stash@{0}` references may have shifted (a
# concurrent session's own stash push/pop on the SAME shared checkout,
# ship-check finding, task #888/BRO-253), so only a SHA read at the moment of
# the pop attempt is guaranteed to name the entry this call is operating on.
# Returns 0 if safe to consider this stash resolved (popped cleanly, or a
# conflict that's provably just daemon churn was auto-resolved), 1 only when a
# genuine unresolved conflict on a non-auto-gen path needs operator attention.
pop_stash_safely() {
  local STASH_SHA
  STASH_SHA=$(g rev-parse -q --verify stash@{0} 2>/dev/null || echo "")
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
    # here is a genuine branch merge conflict.
    #
    # BUT `git stash pop` conflicts NEVER set MERGE_HEAD — that marker is
    # `git merge`-specific, so this branch is also reached for a stash-pop
    # conflict that has nothing to do with any `git merge` at all (e.g. this
    # session's stashed content collides with what origin/$DEFAULT_BRANCH
    # just merged in, a concurrent-push race, not "daemon churn"). Verified
    # live: a `git stash pop` conflict against another session's genuine
    # uncommitted WIP shows up here with MERGE_HEAD absent every time
    # (BRO-253, 2026-08-11 — a real session's edit to a core script was wiped
    # this way, with zero trace, while the script reported success). So a
    # full `reset --hard HEAD` here is NOT provably lossless the way the
    # daemon-churn case assumes — resolve the WORKING TREE (so the shared
    # checkout isn't wedged) but do NOT `stash drop`: keep the stash entry so
    # real content, if any was lost, is still recoverable via `git stash
    # list` / `git stash show -p` instead of gone for good.
    if ! g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
      # Same "was there actually a conflict" check the MERGE_HEAD branch
      # below already does (ship-check finding): `git stash pop` can fail
      # for reasons that leave nothing unmerged (a lock, a transient ref
      # error) — reset --hard HEAD is pointless churn there and the stash is
      # genuinely safe to drop, same as line ~221's parallel case.
      if [ -z "$(g diff --name-only --diff-filter=U 2>/dev/null)" ]; then
        g stash drop >/dev/null 2>&1 || true
        return 0
      fi
      local recover_hint="git -C $MAIN_DIR stash list"
      [ -n "$STASH_SHA" ] && recover_hint="git -C $MAIN_DIR stash show -p $STASH_SHA"
      log "⚠ stash pop conflicted with no merge in progress — resetting working tree (reset --hard HEAD) but KEEPING the stash entry in case the conflicting content was real (not daemon churn). Recover with: $recover_hint"
      g reset --hard HEAD >/dev/null 2>&1 || true
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
        # *.jsonl append-only ledgers are NEVER auto-resolved here, even under
        # cloud-memory/data/audit/public/data/admin — same policy as
        # scripts/lib/sync-audit-checkout.sh (BRO-2364), which refuses
        # snapshot cleanup on any ledger staged as deleted/renamed rather than
        # risk truncating rows a union-merge could otherwise preserve
        # (ship-check/Codex adversarial finding, BRO-3595: this loop's
        # HEAD-missing-path fallback below would otherwise `rm -f` a ledger
        # whose content only exists on $BRANCH's commit, discarding it
        # instead of leaving it for manual/union resolution).
        *.jsonl) unsafe+="$f"$'\n' ;;
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
      if g cat-file -e "HEAD:$f" 2>/dev/null; then
        g checkout HEAD -- "$f" >/dev/null 2>&1 \
          || log "⚠ could not reset $f to HEAD during stash-pop auto-resolution"
      else
        # BRO-3595 (same class as BRO-2364/sync-audit-checkout.sh:397-424):
        # HEAD has no such path — a newly-added auto-gen file (e.g. a brand-new
        # data/audit/*.json snapshot, or a cloud-memory file the background
        # daemon wrote independently after the stash was taken). `git checkout
        # HEAD -- "$f"` errors ("did not match any file(s) known to git") here,
        # which used to be swallowed by `|| true` with no log line, leaving the
        # path unresolved in the index while `g stash drop` still ran and the
        # content was gone for good. Nothing at HEAD to restore, so unstage and
        # remove the working-tree copy instead.
        if g reset -q -- "$f" >/dev/null 2>&1; then
          rm -f -- "$MAIN_DIR/$f" \
            || log "⚠ could not remove newly-added $f during stash-pop auto-resolution"
        else
          log "⚠ could not unstage newly-added $f during stash-pop auto-resolution — leaving it staged"
        fi
      fi
    done <<< "$unmerged"
    g stash drop >/dev/null 2>&1 || true
  fi
}

restore_stash() {
  [ "$STASHED" = 1 ] || return 0
  pop_stash_safely
}

# merge_or_die <ref> <die-message> — `git merge <ref> --no-edit`, surfacing
# git's own combined stdout/stderr in the die() message on failure (task
# #1511). All three merge call sites in this script used to redirect that
# output to /dev/null, leaving the operator zero information on WHY a merge
# failed (real conflict? dirty tree? something else?) — unlike the
# syntax-floor and push-audits die() calls below, which both capture and
# print their command's output.
merge_or_die() {
  local ref="$1" msg="$2" out
  out=$(g merge "$ref" --no-edit 2>&1) || { restore_stash; die "$msg:"$'\n'"$out"; }
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
merge_or_die "origin/$DEFAULT_BRANCH" "merge of origin/$DEFAULT_BRANCH failed — resolve manually"

log "merge $BRANCH"
merge_or_die "$BRANCH" "merge of $BRANCH failed — resolve manually"

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
  # Load the gate from $MAIN_DIR, not $SCRIPT_DIR (BRO-3962). $MAIN_DIR
  # already holds the just-merged tree (the checkout+merge steps above ran
  # `git -C "$MAIN_DIR"`), so its copy of the gate is the correct, current
  # one to run — and, critically, it's the PERMANENT main worktree, never an
  # ephemeral one some session's cleanup (or a stale-worktree janitor) can
  # remove out from under a run in progress. $SCRIPT_DIR is wherever THIS
  # copy of merge-worktree-to-main.sh itself is checked out — a session's own
  # job worktree when run the normal, worktree-first way — so loading the
  # gate from there means both "which checker code runs" and (via
  # acceptance-check-core.js's __dirname-derived DEFAULT_REPO) "what does the
  # baseline `git fetch` target" silently point at that ephemeral location.
  # Falls back to $SCRIPT_DIR's copy only if $MAIN_DIR's is somehow missing
  # (e.g. a very old $MAIN_DIR checkout predating this gate's introduction),
  # so a repo that has never had this file behaves exactly as before.
  GATE_JS="$MAIN_DIR/scripts/lib/merge-post-merge-test-gate.js"
  [ -f "$GATE_JS" ] || GATE_JS="$SCRIPT_DIR/lib/merge-post-merge-test-gate.js"
  if [ -n "$(echo "$CHANGED_FOR_TEST_GATE" | tr -d '[:space:]')" ] && command -v node >/dev/null 2>&1 && [ -f "$GATE_JS" ]; then
    log "post-merge test floor: checking scripts/lib/ colocated tests against the merged tree"
    # MERGE_TEST_GATE_REPO_DIR="$MAIN_DIR": belt-and-suspenders alongside the
    # $MAIN_DIR script-loading fix above — pins the gate's baseline checkout
    # to fetch against the stable main worktree explicitly, rather than
    # relying solely on __dirname inference (see
    # scripts/lib/merge-post-merge-test-gate.js's baselineCheckoutOptions()).
    if ! echo "$CHANGED_FOR_TEST_GATE" | (cd "$MAIN_DIR" && MERGE_TEST_GATE_BASELINE_SHA="$ORIGIN_BASE_SHA" MERGE_TEST_GATE_REPO_DIR="$MAIN_DIR" node "$GATE_JS"); then
      restore_stash
      # BRO-2874, four field reproductions: this used to assert flatly that "the
      # MERGED tree has a NEW-since-origin/main colocated test failure" for ANY
      # non-zero exit of the gate. That is only ONE of the reasons the gate
      # fails. It also fails when the child crashed or timed out and NO
      # individual test failure could be parsed at all (observed as status=7,
      # and as a spawn-layer error where status is null) — cases in which the
      # merged tree may be perfectly clean. The gate prints its own
      # "post-merge test floor: FAILED (<reason>)" line immediately above,
      # naming the real cause; quote that rather than restating a cause this
      # script cannot distinguish. Same shape as the node --check floor above,
      # which prints the real stderr before hedging.
      die "post-merge test floor failed — scroll up to the 'post-merge test floor: FAILED (...)' line for the gate's own reason, which distinguishes a NEW-since-origin/main scripts/lib/ colocated test failure (a semantic collision between two branches, see task #1149/#1433) from a crashed or timed-out run whose output could not be parsed at all. It may be well above this line, after the full test output. Do not assume the former without reading it. If NO such line appears at all, the gate itself failed to start (look for a node stack trace, e.g. a missing scripts/lib/ dependency) and neither diagnosis applies. Resolve in $MAIN_DIR, commit the fix, then re-run this script. (Escape hatches: MERGE_TEST_GATE_SKIP_BASELINE=1 to fall back to old all-or-nothing if the baseline diff itself misbehaves, or MERGE_SKIP_POST_MERGE_TEST_GATE=1 for the whole gate — scripts/merge-worktree-to-main.sh)"
    fi
  fi
fi

# --- Push, integrating remote moves via merge (never rebase) on rejection ---
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — skipping push"
else
  PUSHED=0
  EVER_UNKNOWN=0
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
    if [ "$FETCHED" = 1 ]; then
      HEAD_SHA=$(g rev-parse HEAD 2>/dev/null)
      is_landed "$HEAD_SHA" "$DEFAULT_BRANCH"; LANDED_RC=$?
      if [ "$LANDED_RC" = 0 ]; then
        PUSHED=1; break
      elif [ "$LANDED_RC" = 2 ]; then
        # UNKNOWN (shallow checkout, could not restore full history) — never
        # treat this as landed. Fall through to the same retry path as a
        # plain NOT_LANDED; a few extra retries is the safe failure mode,
        # unlike wrongly declaring success (task #1489). EVER_UNKNOWN tracks
        # this across attempts so the terminal failure message below can
        # tell the user "verification was inconclusive" instead of the
        # flatly wrong "push failed" — the push itself may well have
        # succeeded (ship-check finding: a git push whose remote-tracking
        # ref we simply cannot verify is not the same failure as a rejected
        # push, and telling the user "failed" when it may be live risks a
        # bad recovery decision, exactly the class of incident this file
        # exists to prevent).
        EVER_UNKNOWN=1
        log "ancestry check UNKNOWN (shallow checkout) — treating as not-yet-confirmed, retrying"
      fi
    fi
    if echo "$OUT" | grep -qiE "could not resolve host|failed to connect|timed out" || [ "$FETCHED" = 0 ]; then
      restore_stash; die "GitHub unreachable (network) — re-run when connectivity returns. Local merge is intact."
    fi
    log "push not yet confirmed landed (attempt $attempt) — merging remote and retrying"
    # BRO-2552: re-check for daemon churn right before THIS merge, not just
    # once at script start — by this point in the loop the daemon has had a
    # full push attempt plus fetch/ancestor-check cycle to dirty a tracked
    # file again. Stash-and-pop is scoped TIGHTLY to just this one merge call
    # rather than folding into STASHED/restore_stash: that stash can already
    # be outstanding from the top-of-script check above and won't be popped
    # until the whole push loop finishes, so a second, transiently-
    # outstanding stash here can briefly coexist with it on the stack.
    #
    # Ordering matters (adversarial review before this shipped, both
    # /second-opinion and a Codex pass — see review-verdicts.jsonl): the pop
    # ONLY happens after a merge that completed with NO conflict (checked
    # first, below). If the merge itself conflicts for real, MERGE_HEAD is
    # now set, and pop_stash_safely()'s MERGE_HEAD branch cannot tell "this
    # unmerged path is from the stash-pop I'm about to attempt" apart from
    # "this unmerged path is the retry-merge's OWN unresolved conflict" —
    # calling it in that state risks silently auto-resolving THIS merge's
    # genuine conflict on an allowlisted daemon path to HEAD (discarding the
    # incoming origin diff) before the failure is ever reported, and the
    # resulting die() would misreport a real merge conflict as "the
    # retry-scoped stash pop conflicted" while dropping git's own conflict
    # text. So on a real conflict here, touch NO stash at all — leave
    # MERGE_HEAD and any "wt-integ-*" stash entries exactly as git left them
    # for the operator to resolve, same as this script's other die() paths.
    RETRY_STASHED=0
    if ! g diff --quiet 2>/dev/null || ! g diff --cached --quiet 2>/dev/null; then
      log "working tree dirty again (daemon churn mid-retry) — stashing before remote merge"
      g stash push -m "wt-integ-retry-$$" >/dev/null 2>&1 && RETRY_STASHED=1
    fi
    RETRY_MERGE_OUT=$(g merge "origin/$DEFAULT_BRANCH" --no-edit 2>&1)
    RETRY_MERGE_RC=$?
    if [ "$RETRY_MERGE_RC" != 0 ]; then
      die "could not merge remote changes on retry:"$'\n'"$RETRY_MERGE_OUT"
    fi
    if [ "$RETRY_STASHED" = 1 ]; then
      pop_stash_safely || die "retry-scoped stash pop conflicted on a non-auto-gen path after a CLEAN remote merge — resolve manually in $MAIN_DIR (git -C $MAIN_DIR stash list / stash show -p)"
    fi
  done
  if [ "$PUSHED" != 1 ]; then
    restore_stash
    if [ "$EVER_UNKNOWN" = 1 ]; then
      die "could not CONFIRM the push landed after retries — ancestry checks stayed UNKNOWN (shallow checkout, unshallow failed). This is NOT proof the push failed: verify manually via 'git ls-remote origin $DEFAULT_BRANCH' or the GitHub compare API before assuming the work is lost or re-pushing/force-pushing (task #1489)."
    else
      die "push failed after retries"
    fi
  fi
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
  HEAD_SHA=$(g rev-parse HEAD 2>/dev/null)
  is_landed "$HEAD_SHA" "$DEFAULT_BRANCH"; VERIFY_LANDED_RC=$?
  case "$VERIFY_LANDED_RC" in
    0) : ;; # landed — continue to per-file verify below
    2) die "ancestry check INCONCLUSIVE — local checkout is shallow and could not be restored, so whether HEAD landed on origin/$DEFAULT_BRANCH cannot be determined locally. This is NOT proof the push failed — verify manually via 'git ls-remote origin $DEFAULT_BRANCH' or the GitHub compare API before assuming anything was lost (task #1489)." ;;
    *) die "HEAD is not an ancestor of origin/$DEFAULT_BRANCH — origin's tip moved (concurrent session?) since our push; per-file verify would be unreliable" ;;
  esac

  # `${arr[@]+"${arr[@]}"}` — NOT a bare `"${arr[@]}"`. Under `set -u` (line 24)
  # bash 3.2, the stock /usr/bin/bash on macOS, treats an empty array expansion
  # as an unbound variable and aborts. Since the guard above admits this block
  # when EITHER list is non-empty, the other one is routinely empty: a
  # pure-deletion merge leaves VERIFY_FILES empty, and an explicit
  # `-- file...` caller list leaves DELETED_FILES empty. Aborting here would be
  # worse than the false alarm this all replaced — it happens AFTER a successful
  # push, so the delayed #668 re-verify below never gets scheduled. Same idiom
  # and same reason as scripts/lib/push-with-retry.sh:737 and scripts/hooks/pre-push:53.
  verify_files_on_origin || die "origin/$DEFAULT_BRANCH does not match what we pushed — a file we added is absent, or a file we deleted is still there"
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
