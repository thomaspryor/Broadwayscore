#!/usr/bin/env bash
#
# GC for .claude/worktrees: remove worktrees whose branch is fully merged
# into origin/main. Also: emergency disk-free floor cleanup, stale
# build-artifact stripping, and a digest line for stranded unmerged work.
# Runs hourly + daily via launchd (task #968) — NOT weekly despite the name
# this comment used to carry; fixed after an adversarial review caught the
# doc drift.
#
# MULTI-REPO (BRO-2540): the repo set is data-driven — see
# scripts/lib/worktree-gc-repos.js — instead of a single hardcoded REPO=
# constant. Before this, ~/BroadwayScorecard-app's own .claude/worktrees was
# never touched by anything and grew to 51GB (34GB of it stale, gitignored
# `ios/build` Xcode output) while this script correctly GC'd the web repo
# and reported success every run. Adding a repo to the GC's coverage is now
# a data change (scripts/lib/worktree-gc-repos.js), not a script edit.
#
# SAFETY: `git worktree remove` (plain, no --force) is the default and only path
# for most worktrees — it refuses to remove one with uncommitted changes OR a
# branch with unmerged commits, and that refusal IS the safety property we want.
# The one narrow exception (task #1682) is --force on a worktree that is BOTH (a)
# on a branch whose every commit already landed in origin/main (squash-merges
# included, via `git cherry`) AND (b) is_safe_dirty() — every uncommitted path is
# generated data/ churn, never real source. That combination cannot lose
# committed work (already in origin/main) or real uncommitted work (excluded by
# the allowlist). Branches are KEPT (never `branch -d`) so no history is lost.
# Installed via launchd: ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist
#
# Build-artifact stripping (untouched >STALE_DAYS) never touches worktrees
# with recent file activity, and never touches action-*/detached worktrees —
# same owner-managed exclusions as the merge-removal path. Each repo declares
# its own reclaimable dirs (web: node_modules/.next; iOS: ios/build,
# ios/Pods) — re-running `npm install` / `pod install` / an Xcode build in a
# stripped worktree is the recovery path.
#
# Disk-free floor: below WORKTREE_GC_DISK_FLOOR_GB, run emergency cleanup of
# Xcode DerivedData, stale scratchpad dirs, and unavailable simulators — none
# of which touch worktree state or hold irreplaceable work.
#
# Manual run / dry-run:
#   scripts/gc-merged-worktrees.sh            # remove merged+clean worktrees
#   scripts/gc-merged-worktrees.sh --dry-run  # report only, change nothing
#
# Env overrides (all optional):
#   WORKTREE_GC_STALE_DAYS=3        # build-artifact strip + stale-unmerged digest threshold
#   WORKTREE_GC_DISK_FLOOR_GB=20    # emergency cleanup trigger
#   WORKTREE_GC_SCRATCHPAD_STALE_DAYS=3
#   WORKTREE_GC_REPOS_JSON='[...]'  # override the repo set (scripts/lib/worktree-gc-repos.js)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIMARY_REPO="/Users/tompryor/Broadwayscore"
LOG="$PRIMARY_REPO/data/audit/worktree-gc.log"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

STALE_DAYS="${WORKTREE_GC_STALE_DAYS:-3}"
DISK_FLOOR_GB="${WORKTREE_GC_DISK_FLOOR_GB:-20}"
SCRATCHPAD_STALE_DAYS="${WORKTREE_GC_SCRATCHPAD_STALE_DAYS:-3}"

mkdir -p "$(dirname "$LOG")"

# Single-source-of-truth serialization lock (task #968 follow-up). This
# script now has THREE invocation paths that can overlap: the hourly/daily
# launchd cron, scripts/lib/disk-floor-check.sh's ensure_disk_floor()
# (fires from inside push-with-retry.sh / merge-worktree-to-main.sh when
# disk is critically low — exactly when MANY concurrent sessions hit the
# same branch at once), and manual runs. Locking only inside
# ensure_disk_floor (an earlier version of this fix) missed the cron path
# entirely; locking here covers all three from one place. Non-blocking:
# if another invocation already holds the lock, skip this run rather than
# queuing — a GC that's already in flight will free the same space.
# PID-liveness reclaim (not age-based) matches push-mutex.sh's documented
# reasoning (task #556): age-only reclaim would race a legitimately slow
# holder (a full scan across 60+ worktrees can genuinely take ~5min).
#
# One lock covers the WHOLE multi-repo run (BRO-2540) — a busy lock skips
# every repo in one loud, logged SKIP-RUN line rather than silently
# dropping only the newly added repos while the primary repo's run
# proceeds. Per-repo locking would let a slow web-repo run silently starve
# the iOS repo of GC forever with no log line naming that gap.
GC_LOCK_DIR="/tmp/broadwayscore-disk-floor-gc.lock"
gc_lock_acquired=0
if mkdir "$GC_LOCK_DIR" 2>/dev/null; then
  gc_lock_acquired=1
else
  gc_lock_holder_pid=$(cat "$GC_LOCK_DIR/pid" 2>/dev/null) || true
  if [ -n "${gc_lock_holder_pid:-}" ] && ! kill -0 "$gc_lock_holder_pid" 2>/dev/null; then
    rm -rf "$GC_LOCK_DIR" 2>/dev/null || true
    mkdir "$GC_LOCK_DIR" 2>/dev/null && gc_lock_acquired=1
  fi
fi
if [ "$gc_lock_acquired" != "1" ]; then
  # UTC (BRO-2608): health-check.js's freshness guard reads this log from a
  # UTC GitHub Actions runner, not this (local-TZ) machine — a local-time
  # stamp here would misreport hoursStale by the host's UTC offset.
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] SKIP-RUN — another gc-merged-worktrees.sh invocation already in progress (covers all repos)" | tee -a "$LOG"
  exit 0
fi
echo $$ > "$GC_LOCK_DIR/pid" 2>/dev/null || true
trap 'rmdir "$GC_LOCK_DIR" 2>/dev/null || rm -rf "$GC_LOCK_DIR" 2>/dev/null' EXIT

# UTC (BRO-2608): see SKIP-RUN comment above — this log is read for
# freshness from a UTC runner, so its timestamps must be TZ-independent.
ts() { date -u '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# Free space on the filesystem holding $1 (default PRIMARY_REPO), in whole GB.
# All repos here live on the same local disk, so one check covers them all.
disk_free_gb() {
  local repo_path="${1:-$PRIMARY_REPO}"
  df -Pk "$repo_path" | awk 'NR==2 {print int($4/1024/1024)}'
}

# True (exit 0) iff no file under $1 (excluding node_modules/.next/.git plus
# any extra dirs passed in $3+) was modified in the last $2 days — i.e. the
# worktree looks abandoned rather than mid-edit. Build-tool churn inside
# excluded dirs doesn't count as "touched" — an active Xcode build writing
# into ios/build shouldn't make an otherwise-untouched worktree look fresh.
is_stale() {
  local p="$1" days="$2"; shift 2
  local extra_dirs=("$@") d hit
  local prune_args=(-path '*/node_modules' -o -path '*/.next' -o -path '*/.git')
  for d in "${extra_dirs[@]+"${extra_dirs[@]}"}"; do
    [ -n "$d" ] && prune_args+=(-o -path "*/$d")
  done
  hit=$(find "$p" \( "${prune_args[@]}" \) -prune -o \
    -type f -newermt "-${days} days" -print -quit 2>/dev/null)
  [ -z "$hit" ]
}

# True (exit 0) iff every dirty (modified/untracked) path under worktree $1
# is script-written audit/telemetry churn, never real source or real data —
# data/audit/** only. Deliberately narrower than "any data/*" (an earlier cut
# of this function): data/ also holds data/finances/, data/subscribers.json,
# data/review-texts/ and other real/PII-bearing content (see .gitignore) that
# a session could legitimately leave uncommitted — a blanket data/* allowlist
# would rubber-stamp discarding that (adversarial review, task #1682). Renames
# and oddly-quoted paths are treated conservatively (unsafe) rather than
# parsed. Callers only reach this after the branch is already confirmed fully
# merged into origin/main, so nothing here risks losing committed work — only
# whether it's safe to discard whatever LOCAL uncommitted noise is blocking
# `git worktree remove`. Note: this only sees paths `git status --porcelain`
# reports, i.e. tracked-or-untracked-and-not-ignored files — gitignored
# content (review-texts/, subscribers.json, cookies/, etc.) is invisible to
# it either way and is deleted by ANY worktree removal, force or plain; that
# exposure predates this function and is unchanged by it.
is_safe_dirty() {
  local p="$1" status line f
  status=$(git -C "$p" status --porcelain 2>/dev/null)
  [ -z "$status" ] && return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    f="${line:3}"
    case "$f" in
      *' -> '*) return 1 ;;
      \"*) return 1 ;;
      data/audit/*) ;;
      *) return 1 ;;
    esac
  done <<< "$status"
  return 0
}

human_kb() {
  local kb="$1"
  if [ "$kb" -ge 1048576 ]; then awk -v k="$kb" 'BEGIN{printf "%.1fGB", k/1048576}'
  elif [ "$kb" -ge 1024 ]; then awk -v k="$kb" 'BEGIN{printf "%.1fMB", k/1024}'
  else echo "${kb}KB"; fi
}

# Strips node_modules/.next (plus any repo-specific extra dirs passed in $2+,
# e.g. iOS's ios/build / ios/Pods) from a stale worktree. Sets
# LAST_STRIP_FREED_KB (global, not a subshell return) so the caller can
# accumulate totals without mixing numeric output into log()'s tee'd stdout.
#
# `git check-ignore` gates every candidate (adversarial review, BRO-2540):
# isReclaimableBuildDir()'s isGitIgnored requirement is otherwise dead code —
# nothing enforced it, so a WORKTREE_GC_REPOS_JSON typo or a future
# buildArtifactDirs entry that isn't actually gitignored/regenerable would
# have hit `rm -rf` unconditionally, same as node_modules/.next always did.
# This makes "gitignored" a real, checked precondition for every dir this
# function ever deletes, not just an unenforced doc comment.
#
# Symlinks bypass the check-ignore gate: `git check-ignore` only matches a
# trailing-slash pattern (e.g. `node_modules/`) against an actual directory,
# never a symlink pointing at one — found live in
# BroadwayScorecard-app/.claude/worktrees/my-shows-redesign, whose
# node_modules is a symlink to a shared install one level up. `rm -rf` on a
# symlink only ever removes the link itself, never recurses into whatever it
# points at, so it's unconditionally safe regardless of ignore status.
LAST_STRIP_FREED_KB=0
strip_build_artifacts() {
  local p="$1"; shift
  local extra_dirs=("$@")
  local name freed=0 d sz
  name="$(basename "$p")"
  for d in node_modules .next "${extra_dirs[@]+"${extra_dirs[@]}"}"; do
    [ -z "$d" ] && continue
    if [ -d "$p/$d" ]; then
      if [ ! -L "$p/$d" ] && ! git -C "$p" check-ignore -q -- "$d" 2>/dev/null; then
        log "WARN  [$CURRENT_REPO_NAME] $name/$d — not gitignored per \`git check-ignore\`, refusing to strip (config or .gitignore drift)"
        continue
      fi
      sz=$(du -sk "$p/$d" 2>/dev/null | awk '{print $1}')
      sz=${sz:-0}
      if [ "$DRY_RUN" = "1" ]; then
        log "WOULD-STRIP  $name/$d — $(human_kb "$sz"), untouched >${STALE_DAYS}d"
      else
        rm -rf "${p:?}/$d"
        log "STRIP  $name/$d — freed $(human_kb "$sz"), untouched >${STALE_DAYS}d"
      fi
      freed=$((freed + sz))
    fi
  done
  LAST_STRIP_FREED_KB=$freed
}

# Sets LAST_CLEAN_DD_FREED_KB / LAST_SCRATCHPAD_FREED_KB (global, not a
# subshell return) — same reason as LAST_STRIP_FREED_KB above: log()'s tee'd
# stdout would otherwise get captured alongside the numeric return by any
# caller using `x=$(this_fn)`, corrupting the number (task #968: this exact
# bug was silently breaking check_disk_floor's total below — an `ALERT:
# ...\nCLEAN ...\n0` blob assigned to floor_freed_kb, which then failed
# `$((...))` arithmetic and killed the whole run with "unbound variable"
# before it could log a final freed-space DONE line).
LAST_CLEAN_DD_FREED_KB=0
clean_derived_data() {
  local dd="$HOME/Library/Developer/Xcode/DerivedData" sz
  LAST_CLEAN_DD_FREED_KB=0
  [ -d "$dd" ] || return 0
  sz=$(du -sk "$dd" 2>/dev/null | awk '{print $1}')
  sz=${sz:-0}
  [ "$sz" = "0" ] && return 0
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-CLEAN  DerivedData — $(human_kb "$sz")"
  else
    rm -rf "${dd:?}"/*
    log "CLEAN  DerivedData — freed $(human_kb "$sz")"
  fi
  LAST_CLEAN_DD_FREED_KB=$sz
}

LAST_SCRATCHPAD_FREED_KB=0
clean_stale_scratchpad() {
  local total=0 dir sz
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    is_stale "$dir" "$SCRATCHPAD_STALE_DAYS" || continue
    sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
    sz=${sz:-0}
    [ "$sz" = "0" ] && continue
    if [ "$DRY_RUN" = "1" ]; then
      log "WOULD-CLEAN  scratchpad $(basename "$(dirname "$dir")")/$(basename "$dir") — $(human_kb "$sz"), untouched >${SCRATCHPAD_STALE_DAYS}d"
    else
      rm -rf "${dir:?}"
      log "CLEAN  scratchpad $(basename "$(dirname "$dir")")/$(basename "$dir") — freed $(human_kb "$sz"), untouched >${SCRATCHPAD_STALE_DAYS}d"
    fi
    total=$((total + sz))
  done < <(find "$PRIMARY_REPO" -maxdepth 3 -type d -name scratchpad -not -path '*/node_modules/*' 2>/dev/null)
  LAST_SCRATCHPAD_FREED_KB=$total
}

clean_unavailable_simulators() {
  command -v xcrun >/dev/null 2>&1 || return 0
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-CLEAN  xcrun simctl delete unavailable"
    return 0
  fi
  if xcrun simctl delete unavailable >/dev/null 2>&1; then
    log "CLEAN  xcrun simctl delete unavailable — done"
  else
    log "WARN  xcrun simctl delete unavailable failed (continuing)"
  fi
}

# Emergency cleanup, gated on the free-space floor. None of these touch
# worktree state or unmerged work — DerivedData/scratchpad/sims are all
# regenerable caches. Runs once for the whole machine (shared disk), not
# per repo.
LAST_FLOOR_FREED_KB=0
check_disk_floor() {
  local before after floor_freed=0
  LAST_FLOOR_FREED_KB=0
  before=$(disk_free_gb "$PRIMARY_REPO")
  if [ "$before" -ge "$DISK_FLOOR_GB" ]; then
    return 0
  fi
  log "ALERT: disk free ${before}GB below floor ${DISK_FLOOR_GB}GB — running emergency cleanup"
  clean_derived_data; floor_freed=$((floor_freed + LAST_CLEAN_DD_FREED_KB))
  clean_stale_scratchpad; floor_freed=$((floor_freed + LAST_SCRATCHPAD_FREED_KB))
  clean_unavailable_simulators
  after=$(disk_free_gb "$PRIMARY_REPO")
  log "DIGEST: disk-floor cleanup freed $(human_kb "$floor_freed") — free space ${before}GB -> ${after}GB (floor ${DISK_FLOOR_GB}GB)"
  LAST_FLOOR_FREED_KB=$floor_freed
}

check_disk_floor
floor_freed_kb=$LAST_FLOOR_FREED_KB

# Bound the fetch — a hung network call used to stall the whole GC (and the
# emergency disk-floor cleanup that now runs after it) indefinitely. `timeout`
# comes from Homebrew coreutils; the launchd plist's PATH includes it.
# This script only ever runs interactively/via launchd on a full local
# checkout (never a CI shallow checkout) — audit-unbounded-fetch.js's static
# reachability trace flags it anyway since it's reachable from many
# workflows' require graphs. Already timeout-wrapped below (20s), not the
# unbounded-network-stall case this audit exists to catch.
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

removed=0 kept=0 skipped=0 strip_freed_kb=0 removed_freed_kb=0 orphan_freed_kb=0
# Per-repo state, reset by gc_one_repo() for each repo it processes.
REPO=""
CURRENT_REPO_NAME=""
CURRENT_BUILD_ARTIFACT_DIRS=()
stale_unmerged=()

# Parse `git worktree list --porcelain` into (path, branch) pairs. Reads
# $REPO / $CURRENT_REPO_NAME / $CURRENT_BUILD_ARTIFACT_DIRS, which
# gc_one_repo() sets before invoking this per repo.
path="" branch=""
flush() {
  [ -z "$path" ] && return
  # Skip the main checkout.
  if [ "$path" = "$REPO" ]; then path="" branch=""; return; fi
  if [ -z "$branch" ]; then
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — detached HEAD, leaving alone"
    skipped=$((skipped+1)); path="" branch=""; return
  fi
  # Leave worktrees owned by notion-action-poll.js alone. It creates
  # `action-<cardid>` worktrees off origin/main (so they read as "merged" the
  # instant they're created) and manages their full lifecycle with --force. A
  # freshly-created one is briefly clean before its agent writes anything — a
  # narrow window where this GC could remove it out from under an active poll.
  case "$(basename "$path")" in
    action-*) log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — notion-action-poll worktree, owner-managed"
              skipped=$((skipped+1)); path="" branch=""; return ;;
  esac
  # Merged iff `git cherry` reports no commit missing from upstream ('+' prefix).
  # Empty output (branch == origin/main) also counts as merged. `git cherry`
  # can pathologically hang/spin for minutes on a heavily-diverged branch
  # (observed: 456-run-budget-lib-gaps, 44s+ CPU) — unbounded, that stalls the
  # ENTIRE nightly GC run, which is exactly the silent-failure shape that let
  # disk hit 921MB free with zero warning. Bound it, and on timeout default to
  # "unmerged" (never treat an inconclusive check as license to delete).
  #
  # FAST PATH FIRST (2026-08-09). `git cherry` computes a patch-id for EVERY
  # commit, so it is the expensive way to answer "is this branch already in
  # main" — and under load it mostly does not answer at all: on the 08-09 run,
  # 678 of 759 KEEP decisions were cherry timeouts (exit 124), not merge
  # determinations. The safety default below then kept everything, so the GC
  # reported a clean run while deciding almost nothing. That is the
  # conservative-default-fires-on-the-common-case shape
  # (memory/feedback_conservative_default_can_be_common_case.md).
  #
  # `git merge-base --is-ancestor` is a graph walk: it answers the ordinary
  # merged case (fast-forward / plain merge) in milliseconds and does not time
  # out. When it says yes, the branch is definitively contained in origin/main
  # and no patch-id work is needed. Only when it says no do we still owe the
  # expensive check, because that is the squash-merge case cherry exists to
  # catch (squashed commits are absent from history but present as patches).
  #
  # Shallow- and error-aware (task #1497, same false-negative class as #1489):
  # a raw `merge-base --is-ancestor` on a shallow-truncated shared checkout
  # can answer "no" for a branch that IS fully merged, which would fall
  # through to the (safe but slow) cherry check below — not a correctness
  # bug on its own, but exactly the perf regression this fast path exists to
  # avoid. Route through landing-verify.js so a shallow checkout self-heals
  # (fetch --unshallow) before answering. Fall back to the raw check if node
  # or the lib is unavailable — never silently skip the fast path.
  local cherry_raw cherry_status unmerged head_sha landed_status
  head_sha=$(git rev-parse "$branch" 2>/dev/null)
  landed_status=1
  if [ -n "$head_sha" ]; then
    if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/landing-verify.js" ]; then
      node "$SCRIPT_DIR/lib/landing-verify.js" --sha="$head_sha" --branch=main --remote=origin --cwd="$REPO" >/dev/null 2>&1
      landed_status=$?
    else
      git merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null
      landed_status=$?
    fi
  fi
  if [ -n "$head_sha" ] && [ "$landed_status" = "0" ]; then
    cherry_raw=""      # definitively contained in origin/main
    cherry_status=0
  elif [ -n "$TIMEOUT_BIN" ]; then
    cherry_raw=$("$TIMEOUT_BIN" 15s git cherry origin/main "$branch" 2>/dev/null)
    cherry_status=$?
  else
    cherry_raw=$(git cherry origin/main "$branch" 2>/dev/null)
    cherry_status=$?
  fi
  if [ "$cherry_status" != "0" ]; then
    log "WARN  [$CURRENT_REPO_NAME] $(basename "$path") — git cherry timed out/failed (exit $cherry_status); treating as unmerged (safety default)"
    unmerged=1
  else
    unmerged=$(echo "$cherry_raw" | grep -c '^+')
  fi
  local is_ancestor has_unmerged has_live_lease removable
  is_ancestor=0
  [ "$landed_status" = "0" ] && is_ancestor=1
  has_unmerged=0
  [ "$unmerged" != "0" ] && has_unmerged=1

  # Live-lease guard (BRO-2319): a data/audit/job-leases/* lease with a live
  # pid pointed at this exact path means a job is actively using it RIGHT
  # NOW — never remove it, whatever the merge status says (a resumed job can
  # keep committing to an already-landed branch). Exit-code contract matches
  # gc-worktree-liveness.js below: 0 = live (do not remove), 1 = clear. Same
  # narrow TOCTOU window as that lsof-based check — a lease acquired between
  # this check and `git worktree remove` running is possible but not
  # something either check can close; git's own dirty-tree refusal is the
  # last line of defense for that gap. Scope: this only protects job-*
  # worktrees dispatched via bsc-runner.js's lease; other worktrees (e.g.
  # autonomous-run.js's auto-*) rely solely on the lsof-based check below.
  # Generic across repos: it matches on the worktree's absolute path, not on
  # which repo owns it, so iOS-repo worktrees get the same protection.
  has_live_lease=0
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/worktree-live-lease-check.js" ]; then
    node "$SCRIPT_DIR/lib/worktree-live-lease-check.js" --path="$path" >/dev/null 2>&1
    [ "$?" = "0" ] && has_live_lease=1
  else
    log "WARN  live-lease guard unavailable (node or worktree-live-lease-check.js missing) — skipping for [$CURRENT_REPO_NAME] $(basename "$path")"
  fi

  # Single decision point (worktree-gc-decide.js -> decideWorktreeReclaim in
  # scripts/lib/worktree-gc-reclaim.js): the three signals gathered above
  # (ancestor check, unmerged count, live-lease scan) all funnel through the
  # SAME function this file's own unit tests exercise, instead of bash
  # re-deciding with its own parallel `if` chain.
  removable=1
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/worktree-gc-decide.js" ]; then
    node "$SCRIPT_DIR/lib/worktree-gc-decide.js" \
      --is-ancestor="$is_ancestor" --has-unmerged="$has_unmerged" --has-live-lease="$has_live_lease" >/dev/null 2>&1
    [ "$?" != "0" ] && removable=0
  else
    log "WARN  decision helper unavailable (node or worktree-gc-decide.js missing) — falling back to unmerged-only check"
    [ "$has_unmerged" = "1" ] && removable=0
  fi

  if [ "$has_live_lease" = "1" ]; then
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch has a live job-lease using this worktree as its cwd"
    skipped=$((skipped+1))
    path="" branch=""; return
  fi

  if [ "$removable" != "1" ]; then
    log "KEEP  [$CURRENT_REPO_NAME] $(basename "$path") — $unmerged unmerged commit(s) on $branch"
    kept=$((kept+1))
    # Never delete unmerged worktrees — they may hold stranded work (task
    # #335). Just flag them for the digest line if they've gone quiet.
    if is_stale "$path" "$STALE_DAYS" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"; then
      stale_unmerged+=("$CURRENT_REPO_NAME/$(basename "$path")")
      strip_build_artifacts "$path" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"
      strip_freed_kb=$((strip_freed_kb + LAST_STRIP_FREED_KB))
    fi
    path="" branch=""; return
  fi
  # Liveness guard (task #1709): git's dirty-tree refusal protects
  # uncommitted changes, but a merged+CLEAN worktree can still be a live
  # process's cwd (a dev server, a background watcher) — there's nothing
  # dirty for git to refuse on, so plain `git worktree remove` would happily
  # pull the rug out from under it. Found 2026-08-16: tony-page-season-guard
  # was removed while pids 93138/93152 still had it as their cwd. Skip, same
  # as the dirty-tree skip below, rather than risk that. Generic across
  # repos, same reasoning as the live-lease guard above.
  # Exit-code contract: the CLI wrapper is a 2-way switch, not 3-way — exit 0
  # means "live, do not remove"; ANYTHING else (1 = clear, 2 = usage error,
  # or an unanticipated crash) falls through to removal below. Keep it that
  # way deliberately (an unexpected non-zero must never become a silent KEEP
  # that masks a real bug in the checker) but don't widen it without
  # re-reading this comment.
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/gc-worktree-liveness.js" ]; then
    node "$SCRIPT_DIR/lib/gc-worktree-liveness.js" --path="$path" >/dev/null 2>&1
    if [ "$?" = "0" ]; then
      log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged but a live process has this worktree as its cwd"
      skipped=$((skipped+1))
      path="" branch=""; return
    fi
  else
    log "WARN  liveness guard unavailable (node or gc-worktree-liveness.js missing) — skipping liveness check for [$CURRENT_REPO_NAME] $(basename "$path")"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    if is_safe_dirty "$path"; then
      log "WOULD-FORCE-REMOVE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, only generated data/ churn dirty"
    else
      log "WOULD-REMOVE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch fully merged"
    fi
    removed=$((removed+1)); path="" branch=""; return
  fi
  # Measured before removal so the DONE summary's freed= reflects what
  # actually left disk, not just the floor/strip/orphan side-cleanups (task
  # #1682: a run that reclaimed 26GB across dozens of worktree removals
  # logged "freed=797.9MB" because this size was never captured — accurate
  # for the wrong reason next time someone reads this log to judge impact).
  local removal_sz
  removal_sz=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
  removal_sz=${removal_sz:-0}
  # Plain remove (NO --force): git refuses if the working tree is dirty.
  if git worktree remove "$path" 2>/dev/null; then
    log "REMOVE [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, worktree removed (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
  elif is_safe_dirty "$path" && git worktree remove --force "$path" 2>/dev/null; then
    # Only reached when the branch is already fully merged AND every dirty
    # path is generated data/ churn (is_safe_dirty) — this is what makes
    # --force safe here despite the file header's "never uses --force" claim
    # for the general case. Without this, merged branches sit forever behind
    # trivial cron-written diffs to data/audit/*.json (task #1682: 51/56
    # dirty worktrees were stuck this way, gc reporting freed=0KB run after
    # run while disk hit 99% full).
    log "FORCE-REMOVE [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, discarded uncommitted data/ churn (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
  else
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — merged but worktree dirty; not forcing"
    skipped=$((skipped+1))
    # Merged-but-dirty worktrees can sit indefinitely (git won't remove them
    # while dirty) — same staleness treatment as unmerged ones.
    if is_stale "$path" "$STALE_DAYS" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"; then
      strip_build_artifacts "$path" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"
      strip_freed_kb=$((strip_freed_kb + LAST_STRIP_FREED_KB))
    fi
  fi
  path="" branch=""
}

# Runs the full GC pass (merge-removal loop, worktree prune, orphan sweep,
# per-repo digest) against one repo. $1=name $2=path $3=worktree-subdir,
# remaining args = that repo's buildArtifactDirs.
gc_one_repo() {
  local repo_name="$1" repo_path="$2" worktree_subdir="$3"; shift 3
  local build_dirs=("$@")

  if [ ! -d "$repo_path/.git" ]; then
    log "WARN  repo '$repo_name' — no .git at $repo_path, skipping"
    return
  fi

  REPO="$repo_path"
  CURRENT_REPO_NAME="$repo_name"
  CURRENT_BUILD_ARTIFACT_DIRS=("${build_dirs[@]+"${build_dirs[@]}"}")
  stale_unmerged=()

  if ! cd "$REPO"; then
    log "WARN  repo '$repo_name' — cd to $REPO failed, skipping"
    return
  fi

  if [ -n "$TIMEOUT_BIN" ]; then
    # unbounded-fetch-ok: bounded by $TIMEOUT_BIN 20s; see file header.
    "$TIMEOUT_BIN" 20s git fetch origin main -q 2>/dev/null || log "WARN: [$repo_name] git fetch failed or timed out (offline?) — using cached origin/main"
  else
    # unbounded-fetch-ok: only reached when timeout/gtimeout is absent (rare local machine); see file header.
    git fetch origin main -q 2>/dev/null || log "WARN: [$repo_name] git fetch failed (offline?) — using cached origin/main"
  fi

  path="" branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) flush; path="${line#worktree }" ;;
      "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
      "detached") branch="" ;;
    esac
  done < <(git worktree list --porcelain)
  flush

  git worktree prune 2>/dev/null

  # Orphaned worktree directories: present on disk under the repo's worktree
  # dir but NOT registered with git (left behind by an interrupted `rm -rf`
  # or a partial force-remove elsewhere). `git worktree prune` only clears
  # git's OWN bookkeeping for a worktree whose directory went missing — the
  # opposite case, a directory git has no record of at all — is invisible to
  # it, so these silently accumulate disk forever (task #1682: found 5 such
  # dirs, ~800MB, sitting untouched for 3+ weeks).
  #
  # Two independent guards before deleting (adversarial review, task #1682):
  #  1. action-* excluded, same as the main loop — notion-action-poll.js
  #     manages these with its own --force lifecycle; one could be
  #     unregistered for a moment mid-cycle and this sweep must not race that.
  #  2. Any trace of `.git` (file or dir) inside the candidate — even a
  #     broken one pointing at a gitdir that no longer exists — means
  #     WARN-only, not delete. A directory with zero git artifacts at all can
  #     hold no commit unreachable from a branch ref; one that once had a
  #     `.git` might, and "the commits live on via their branch ref" is not
  #     something this loop can verify from a dead gitdir pointer. Left for
  #     manual triage.
  # A 15-minute freshness guard on top avoids racing a worktree that's
  # mid-creation (directory written before git's registration step completes).
  local worktrees_root="$REPO/$worktree_subdir"
  if [ -d "$worktrees_root" ]; then
    local registered_paths=() reg_line
    while IFS= read -r reg_line; do
      case "$reg_line" in
        "worktree "*) registered_paths+=("${reg_line#worktree }") ;;
      esac
    done < <(git worktree list --porcelain)
    is_registered() {
      local d="$1" r
      for r in "${registered_paths[@]+"${registered_paths[@]}"}"; do [ "$r" = "$d" ] && return 0; done
      return 1
    }
    local dir orphan_name orphan_sz
    while IFS= read -r dir; do
      [ -z "$dir" ] && continue
      orphan_name="$(basename "$dir")"
      is_registered "$dir" && continue
      case "$orphan_name" in
        action-*) continue ;;
      esac
      if [ -e "$dir/.git" ]; then
        log "WARN  [$repo_name] $orphan_name — unregistered but has a .git artifact; leaving for manual triage (not auto-deleted)"
        continue
      fi
      find "$dir" -newermt '-15 minutes' -print -quit 2>/dev/null | grep -q . && continue
      orphan_sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
      orphan_sz=${orphan_sz:-0}
      if [ "$DRY_RUN" = "1" ]; then
        log "WOULD-REMOVE-ORPHAN  [$repo_name] $orphan_name — $(human_kb "$orphan_sz"), not registered with git worktree list"
      else
        rm -rf "${dir:?}"
        log "REMOVE-ORPHAN  [$repo_name] $orphan_name — freed $(human_kb "$orphan_sz"), not registered with git worktree list"
      fi
      orphan_freed_kb=$((orphan_freed_kb + orphan_sz))
    done < <(find "$worktrees_root" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
  fi

  if [ "${#stale_unmerged[@]}" -gt 0 ]; then
    log "DIGEST[$repo_name]: ${#stale_unmerged[@]} unmerged worktree(s) untouched >${STALE_DAYS}d holding stranded work: ${stale_unmerged[*]}"
  else
    log "DIGEST[$repo_name]: no stale-unmerged worktrees (>${STALE_DAYS}d untouched)"
  fi
}

# Load the data-driven repo set. Falls back to the web repo alone (the
# pre-BRO-2540 behaviour) if node or the config module is unavailable —
# loud (WARN, tee'd to $LOG), never a silent zero-repo no-op.
GC_REPO_LINES=""
if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/worktree-gc-repos.js" ]; then
  GC_REPO_LINES="$(node "$SCRIPT_DIR/lib/worktree-gc-repos.js" --list 2>/dev/null)"
fi
if [ -z "$GC_REPO_LINES" ]; then
  log "WARN  worktree-gc-repos.js unavailable — falling back to web repo only"
  GC_REPO_LINES=$'web\t'"$PRIMARY_REPO"$'\t.claude/worktrees\tnode_modules,.next'
fi

while IFS=$'\t' read -r r_name r_path r_wtdir r_builddirs; do
  [ -z "$r_name" ] && continue
  # A repo with no configured build-artifact dirs (e.g. the web repo) leaves
  # r_builddirs empty, so `read -a` produces a zero-element array. Bare
  # "${build_dirs_arr[@]}" on a zero-element array trips "unbound variable"
  # under `set -u` on macOS's /bin/bash (3.2 — the empty-array-expansion bug
  # fixed upstream in bash 4.4), crashing the whole script on its very first
  # loop iteration (BRO-2186: silent since the BRO-2540 multi-repo refactor
  # landed — every launchd/manual run failed before gc_one_repo ran once).
  # The `${arr[@]+"${arr[@]}"}` alternate-value form expands to nothing for
  # a zero-element array instead of dereferencing it directly — verified
  # against this exact bash 3.2 build. Same fix needed at every other
  # CURRENT_BUILD_ARTIFACT_DIRS/build_dirs expansion site in this file.
  IFS=',' read -r -a build_dirs_arr <<< "$r_builddirs"
  gc_one_repo "$r_name" "$r_path" "$r_wtdir" "${build_dirs_arr[@]+"${build_dirs_arr[@]}"}"
done <<< "$GC_REPO_LINES"

total_freed_kb=$((floor_freed_kb + strip_freed_kb + orphan_freed_kb + removed_freed_kb))
log "DONE  removed=$removed kept=$kept skipped=$skipped freed=$(human_kb "$total_freed_kb") (dry_run=$DRY_RUN)"
