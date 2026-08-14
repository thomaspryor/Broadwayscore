#!/usr/bin/env bash
#
# GC for .claude/worktrees: remove worktrees whose branch is fully merged
# into origin/main. Also: emergency disk-free floor cleanup, stale
# build-artifact stripping, and a digest line for stranded unmerged work.
# Runs hourly + daily via launchd (task #968) — NOT weekly despite the name
# this comment used to carry; fixed after an adversarial review caught the
# doc drift.
#
# SAFETY: never uses --force. `git worktree remove` (plain) refuses to remove a
# worktree that has uncommitted changes OR a branch with unmerged commits — that
# refusal IS the safety property we want. The job only ever removes worktrees
# that are both (a) on a branch whose every commit already landed in origin/main
# (squash-merges included, via `git cherry`) and (b) clean enough that git is
# willing to remove them. Branches are KEPT (never `branch -d`) so no history is
# lost. Installed via launchd: ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist
#
# node_modules/.next stripping (untouched >STALE_DAYS) never touches worktrees
# with recent file activity, and never touches action-*/detached worktrees —
# same owner-managed exclusions as the merge-removal path. Re-running `npm
# install` / `npm run build` in a stripped worktree is the recovery path.
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
#   WORKTREE_GC_STALE_DAYS=3        # node_modules/.next strip + stale-unmerged digest threshold
#   WORKTREE_GC_DISK_FLOOR_GB=20    # emergency cleanup trigger
#   WORKTREE_GC_SCRATCHPAD_STALE_DAYS=3
#
set -uo pipefail

REPO="/Users/tompryor/Broadwayscore"
LOG="$REPO/data/audit/worktree-gc.log"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

STALE_DAYS="${WORKTREE_GC_STALE_DAYS:-3}"
DISK_FLOOR_GB="${WORKTREE_GC_DISK_FLOOR_GB:-20}"
SCRATCHPAD_STALE_DAYS="${WORKTREE_GC_SCRATCHPAD_STALE_DAYS:-3}"

cd "$REPO" || { echo "repo not found: $REPO" >&2; exit 1; }
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
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP-RUN — another gc-merged-worktrees.sh invocation already in progress" | tee -a "$LOG"
  exit 0
fi
echo $$ > "$GC_LOCK_DIR/pid" 2>/dev/null || true
trap 'rmdir "$GC_LOCK_DIR" 2>/dev/null || rm -rf "$GC_LOCK_DIR" 2>/dev/null' EXIT

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# Free space on the worktree filesystem, in whole GB.
disk_free_gb() {
  df -Pk "$REPO" | awk 'NR==2 {print int($4/1024/1024)}'
}

# True (exit 0) iff no file under $1 (excluding node_modules/.next/.git) was
# modified in the last $2 days — i.e. the worktree looks abandoned rather than
# mid-edit. Build-tool churn inside node_modules/.next doesn't count as "touched".
is_stale() {
  local p="$1" days="$2" hit
  hit=$(find "$p" \
    \( -path '*/node_modules' -o -path '*/.next' -o -path '*/.git' \) -prune -o \
    -type f -newermt "-${days} days" -print -quit 2>/dev/null)
  [ -z "$hit" ]
}

human_kb() {
  local kb="$1"
  if [ "$kb" -ge 1048576 ]; then awk -v k="$kb" 'BEGIN{printf "%.1fGB", k/1048576}'
  elif [ "$kb" -ge 1024 ]; then awk -v k="$kb" 'BEGIN{printf "%.1fMB", k/1024}'
  else echo "${kb}KB"; fi
}

# Strips node_modules/.next from a stale worktree. Sets LAST_STRIP_FREED_KB
# (global, not a subshell return) so the caller can accumulate totals without
# mixing numeric output into log()'s tee'd stdout.
LAST_STRIP_FREED_KB=0
strip_build_artifacts() {
  local p="$1" name freed=0 d sz
  name="$(basename "$p")"
  for d in node_modules .next; do
    if [ -d "$p/$d" ]; then
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
  done < <(find "$REPO" -maxdepth 3 -type d -name scratchpad -not -path '*/node_modules/*' 2>/dev/null)
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
# regenerable caches.
LAST_FLOOR_FREED_KB=0
check_disk_floor() {
  local before after floor_freed=0
  LAST_FLOOR_FREED_KB=0
  before=$(disk_free_gb)
  if [ "$before" -ge "$DISK_FLOOR_GB" ]; then
    return 0
  fi
  log "ALERT: disk free ${before}GB below floor ${DISK_FLOOR_GB}GB — running emergency cleanup"
  clean_derived_data; floor_freed=$((floor_freed + LAST_CLEAN_DD_FREED_KB))
  clean_stale_scratchpad; floor_freed=$((floor_freed + LAST_SCRATCHPAD_FREED_KB))
  clean_unavailable_simulators
  after=$(disk_free_gb)
  log "DIGEST: disk-floor cleanup freed $(human_kb "$floor_freed") — free space ${before}GB -> ${after}GB (floor ${DISK_FLOOR_GB}GB)"
  LAST_FLOOR_FREED_KB=$floor_freed
}

# Bound the fetch — a hung network call used to stall the whole GC (and the
# emergency disk-floor cleanup that now runs after it) indefinitely. `timeout`
# comes from Homebrew coreutils; the launchd plist's PATH includes it.
# This script only ever runs interactively/via launchd on a full local
# checkout (never a CI shallow checkout) — audit-unbounded-fetch.js's static
# reachability trace flags it anyway since it's reachable from many
# workflows' require graphs. Already timeout-wrapped below (20s), not the
# unbounded-network-stall case this audit exists to catch.
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
if [ -n "$TIMEOUT_BIN" ]; then
  # unbounded-fetch-ok: bounded by $TIMEOUT_BIN 20s above; see block comment above.
  "$TIMEOUT_BIN" 20s git fetch origin main -q 2>/dev/null || log "WARN: git fetch failed or timed out (offline?) — using cached origin/main"
else
  # unbounded-fetch-ok: only reached when timeout/gtimeout is absent (rare local machine); see block comment above.
  git fetch origin main -q 2>/dev/null || log "WARN: git fetch failed (offline?) — using cached origin/main"
fi

check_disk_floor
floor_freed_kb=$LAST_FLOOR_FREED_KB

removed=0 kept=0 skipped=0 strip_freed_kb=0
stale_unmerged=()

# Parse `git worktree list --porcelain` into (path, branch) pairs.
path="" branch=""
flush() {
  [ -z "$path" ] && return
  # Skip the main checkout.
  if [ "$path" = "$REPO" ]; then path="" branch=""; return; fi
  if [ -z "$branch" ]; then
    log "SKIP  $(basename "$path") — detached HEAD, leaving alone"
    skipped=$((skipped+1)); path="" branch=""; return
  fi
  # Leave worktrees owned by notion-action-poll.js alone. It creates
  # `action-<cardid>` worktrees off origin/main (so they read as "merged" the
  # instant they're created) and manages their full lifecycle with --force. A
  # freshly-created one is briefly clean before its agent writes anything — a
  # narrow window where this GC could remove it out from under an active poll.
  case "$(basename "$path")" in
    action-*) log "SKIP  $(basename "$path") — notion-action-poll worktree, owner-managed"
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
    if command -v node >/dev/null 2>&1 && [ -f "$REPO/scripts/lib/landing-verify.js" ]; then
      node "$REPO/scripts/lib/landing-verify.js" --sha="$head_sha" --branch=main --remote=origin --cwd="$REPO" >/dev/null 2>&1
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
    log "WARN  $(basename "$path") — git cherry timed out/failed (exit $cherry_status); treating as unmerged (safety default)"
    unmerged=1
  else
    unmerged=$(echo "$cherry_raw" | grep -c '^+')
  fi
  if [ "$unmerged" != "0" ]; then
    log "KEEP  $(basename "$path") — $unmerged unmerged commit(s) on $branch"
    kept=$((kept+1))
    # Never delete unmerged worktrees — they may hold stranded work (task
    # #335). Just flag them for the digest line if they've gone quiet.
    if is_stale "$path" "$STALE_DAYS"; then
      stale_unmerged+=("$(basename "$path")")
      strip_build_artifacts "$path"
      strip_freed_kb=$((strip_freed_kb + LAST_STRIP_FREED_KB))
    fi
    path="" branch=""; return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-REMOVE  $(basename "$path") — $branch fully merged"
    removed=$((removed+1)); path="" branch=""; return
  fi
  # Plain remove (NO --force): git refuses if the working tree is dirty.
  if git worktree remove "$path" 2>/dev/null; then
    log "REMOVE $(basename "$path") — $branch merged, worktree removed (branch kept)"
    removed=$((removed+1))
  else
    log "SKIP  $(basename "$path") — merged but worktree dirty; not forcing"
    skipped=$((skipped+1))
    # Merged-but-dirty worktrees can sit indefinitely (git won't remove them
    # while dirty) — same staleness treatment as unmerged ones.
    if is_stale "$path" "$STALE_DAYS"; then
      strip_build_artifacts "$path"
      strip_freed_kb=$((strip_freed_kb + LAST_STRIP_FREED_KB))
    fi
  fi
  path="" branch=""
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; path="${line#worktree }" ;;
    "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
    "detached") branch="" ;;
  esac
done < <(git worktree list --porcelain)
flush

git worktree prune 2>/dev/null

if [ "${#stale_unmerged[@]}" -gt 0 ]; then
  log "DIGEST: ${#stale_unmerged[@]} unmerged worktree(s) untouched >${STALE_DAYS}d holding stranded work: ${stale_unmerged[*]}"
else
  log "DIGEST: no stale-unmerged worktrees (>${STALE_DAYS}d untouched)"
fi

total_freed_kb=$((floor_freed_kb + strip_freed_kb))
log "DONE  removed=$removed kept=$kept skipped=$skipped freed=$(human_kb "$total_freed_kb") (dry_run=$DRY_RUN)"
