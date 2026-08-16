#!/usr/bin/env bash
#
# GC for .claude/worktrees: remove worktrees whose branch is fully merged
# into origin/main. Also: emergency disk-free floor cleanup, stale
# build-artifact stripping, and a digest line for stranded unmerged work.
# Runs hourly + daily via launchd (task #968) — NOT weekly despite the name
# this comment used to carry; fixed after an adversarial review caught the
# doc drift.
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

# True (exit 0) iff every dirty (modified/untracked) path under worktree $1
# is generated pipeline/audit data, never real source — data/**, excluding
# the two files explicitly documented as source-of-truth (CLAUDE.md §3) that
# could legitimately hold real uncommitted curated edits. Renames and
# oddly-quoted paths are treated conservatively (unsafe) rather than parsed.
# Callers only reach this after the branch is already confirmed fully merged
# into origin/main, so nothing here risks losing committed work — only
# whether it's safe to discard whatever LOCAL uncommitted noise is blocking
# `git worktree remove`.
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
      data/shows.json|data/reviews.json) return 1 ;;
      data/*) ;;
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

removed=0 kept=0 skipped=0 strip_freed_kb=0 removed_freed_kb=0
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
    if is_safe_dirty "$path"; then
      log "WOULD-FORCE-REMOVE  $(basename "$path") — $branch merged, only generated data/ churn dirty"
    else
      log "WOULD-REMOVE  $(basename "$path") — $branch fully merged"
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
    log "REMOVE $(basename "$path") — $branch merged, worktree removed (branch kept)"
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
    log "FORCE-REMOVE $(basename "$path") — $branch merged, discarded uncommitted data/ churn (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
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

# Orphaned worktree directories: present on disk under .claude/worktrees but
# NOT registered with git (a broken/missing .git pointer, left behind by an
# interrupted `rm -rf` or a partial force-remove elsewhere). `git worktree
# prune` only clears git's OWN bookkeeping for a worktree whose directory
# went missing — the opposite case, a directory git has no record of at all —
# is invisible to it, so these silently accumulate disk forever (task #1682:
# found 5 such dirs, ~800MB, sitting untouched for 3+ weeks). Safe to delete:
# with zero git registration there is no worktree lock, admin entry, or
# uncommitted-change protection `git worktree remove` could offer — any real
# commits made in one live on via their branch ref regardless of whether this
# checkout directory exists. A 15-minute freshness guard avoids racing a
# worktree that's mid-creation (directory written before git's registration
# step completes).
orphan_freed_kb=0
if [ -d "$REPO/.claude/worktrees" ]; then
  registered=$(git worktree list --porcelain | awk '/^worktree /{print $2}')
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    orphan_name="$(basename "$dir")"
    echo "$registered" | grep -qxF "$dir" && continue
    find "$dir" -newermt '-15 minutes' -print -quit 2>/dev/null | grep -q . && continue
    orphan_sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
    orphan_sz=${orphan_sz:-0}
    if [ "$DRY_RUN" = "1" ]; then
      log "WOULD-REMOVE-ORPHAN  $orphan_name — $(human_kb "$orphan_sz"), not registered with git worktree list"
    else
      rm -rf "${dir:?}"
      log "REMOVE-ORPHAN  $orphan_name — freed $(human_kb "$orphan_sz"), not registered with git worktree list"
    fi
    orphan_freed_kb=$((orphan_freed_kb + orphan_sz))
  done < <(find "$REPO/.claude/worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi

if [ "${#stale_unmerged[@]}" -gt 0 ]; then
  log "DIGEST: ${#stale_unmerged[@]} unmerged worktree(s) untouched >${STALE_DAYS}d holding stranded work: ${stale_unmerged[*]}"
else
  log "DIGEST: no stale-unmerged worktrees (>${STALE_DAYS}d untouched)"
fi

total_freed_kb=$((floor_freed_kb + strip_freed_kb + orphan_freed_kb + removed_freed_kb))
log "DONE  removed=$removed kept=$kept skipped=$skipped freed=$(human_kb "$total_freed_kb") (dry_run=$DRY_RUN)"
