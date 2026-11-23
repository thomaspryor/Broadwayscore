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
# Xcode DerivedData, stale scratchpad dirs, stale gh run-log zips and
# unavailable simulators — none
# of which touch worktree state or hold irreplaceable work.
#
# Manual run / dry-run:
#   scripts/gc-merged-worktrees.sh            # remove merged+clean worktrees
#   scripts/gc-merged-worktrees.sh --dry-run  # report only, change nothing
#
# Env overrides (all optional):
#   WORKTREE_GC_STALE_DAYS=3        # build-artifact strip + stale-unmerged digest threshold
#   WORKTREE_GC_RETIRE_STALE_DAYS=3 # idle job-* worktree with unlanded branch: remove worktree, keep branch (BRO-5378)
#   WORKTREE_GC_RETIRE_STALE_JOBS=0 # turn that off
#   WORKTREE_GC_DISK_FLOOR_GB=20    # emergency cleanup trigger
#   WORKTREE_GC_SCRATCHPAD_STALE_DAYS=3
#   WORKTREE_GC_REPOS_JSON='[...]'  # override the repo set (scripts/lib/worktree-gc-repos.js)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIMARY_REPO="/Users/tompryor/Broadwayscore"
# WORKTREE_GC_LOG is a test seam only (BRO-2607): the parity test drives this
# real script against fixture worktrees and must not append fixture lines to
# the committed audit log. Production never sets it.
LOG="${WORKTREE_GC_LOG:-$PRIMARY_REPO/data/audit/worktree-gc.log}"
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
# WORKTREE_GC_LOCK_DIR: same test-seam reasoning as WORKTREE_GC_LOG above, but
# validated, because this path becomes an `rm -rf` target twice below (the
# stale-pid reclaim and the EXIT trap). Only a temp-dir path is accepted; any
# other value falls back to the production lock rather than pointing a delete
# at, say, a home directory. Same posture as worktree-gc-repos.js, whose
# override for this script is validated by isValidRepoEntry().
GC_LOCK_DIR_DEFAULT="/tmp/broadwayscore-disk-floor-gc.lock"
GC_LOCK_DIR="$GC_LOCK_DIR_DEFAULT"
# A temp-root prefix ALONE is not enough: session scratchpads and other real
# working directories live under /private/tmp, and an accepted value is an
# `rm -rf` target. Verified 2026-08-31 — an earlier, prefix-only version of
# this guard accepted a scratchpad path and deleted it. So also require the
# LAST path component to be lock-shaped, which no working directory is.
if [ -n "${WORKTREE_GC_LOCK_DIR:-}" ]; then
  gc_lock_override_ok=0
  case "$WORKTREE_GC_LOCK_DIR" in
    *..*) ;;                                       # reject traversal outright
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*)
      case "${WORKTREE_GC_LOCK_DIR##*/}" in
        lock|*.lock|*-lock) GC_LOCK_DIR="$WORKTREE_GC_LOCK_DIR"; gc_lock_override_ok=1 ;;
      esac
      ;;
  esac
  # Track acceptance explicitly. Inferring it from
  # [ "$GC_LOCK_DIR" = "$GC_LOCK_DIR_DEFAULT" ] mislabels the case where the
  # caller passes the production path itself — that path ends in .lock and IS
  # accepted, but the equality test called it "rejected" straight into the
  # committed audit log people read during a disk incident.
  if [ "$gc_lock_override_ok" != "1" ]; then
    # UTC (BRO-2608): this writes to the same $LOG the freshness guard reads
    # on a UTC runner — a local-time stamp here would misreport hoursStale
    # exactly like the bug that fix closed, if this line ever became newest.
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] WARN  WORKTREE_GC_LOCK_DIR rejected (must be a temp-dir path whose last component is lock/*.lock/*-lock) — using the production lock" | tee -a "$LOG"
  fi
fi
# Validate-only mode: exit after the lock-path decision, before acquiring any
# lock. Lets the lock suite assert the rejection branch WITHOUT the run going on
# to take the PRODUCTION lock and delete it in its EXIT trap, which on this Mac
# forces a concurrent launchd GC to SKIP-RUN. Production never sets it.
if [ -n "${WORKTREE_GC_VALIDATE_ONLY:-}" ]; then
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] VALIDATE-ONLY  lock dir resolved to $GC_LOCK_DIR" | tee -a "$LOG"
  exit 0
fi
# -p on the PARENT (not the lock dir itself — the lock's atomicity depends on
# mkdir failing when it already exists). Without this a valid but parentless
# override fails ENOENT, the stale-pid branch finds no pid file, and the script
# reports "another invocation already in progress" forever when nothing is.
mkdir -p "$(dirname "$GC_LOCK_DIR")" 2>/dev/null || true
# BRO-8124: reap leaked makeFreshCheckout temp checkouts BEFORE the global
# lock. On 2026-11-23 one GC pass held that lock for 10 hours, so every hourly
# run and bsc-runner's disk-pressure self-heal hit SKIP-RUN and 19GB of
# 1-4GB checkouts piled up. This pass has its own safety rules (dead owner or
# 60m idle, nothing open under it, HEAD on origin/main) and takes ~seconds.
# Skipped under the WORKTREE_GC_REPOS_JSON test seam unless the test names
# its own TEMP_CHECKOUT_REAP_ROOTS, so a fixture run never scans the real /tmp.
if [ -z "${WORKTREE_GC_REPOS_JSON:-}" ] || [ -n "${TEMP_CHECKOUT_REAP_ROOTS:-}" ]; then
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/reap-temp-checkouts.js" ]; then
    _tcr_args=(--all)
    # Registered tmp worktrees of the real repo too, unless a test seam is set.
    [ -z "${WORKTREE_GC_REPOS_JSON:-}" ] && _tcr_args+=(--repo "$PRIMARY_REPO")
    [ "$DRY_RUN" = "1" ] && _tcr_args+=(--dry-run)
    node "$SCRIPT_DIR/lib/reap-temp-checkouts.js" "${_tcr_args[@]}" 2>&1 \
      | while IFS= read -r _tcr_line; do echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $_tcr_line"; done | tee -a "$LOG" || true
  fi
fi
# BRO-8179: reap every other stale top-level /private/tmp entry (test mkdtemp
# litter, idle session clones): ~140k entries / ~20GB a day, never removed
# because macOS clears /tmp only at reboot. Own safety rules (age tiers, lsof,
# git local work) in reap-stale-tmp.js; budgeted so one pass cannot hold the
# hourly run. Test seam: skipped under WORKTREE_GC_REPOS_JSON unless the test
# names its own TMP_REAP_ROOT, so a fixture run never touches the real /tmp.
if [ -z "${WORKTREE_GC_REPOS_JSON:-}" ] || [ -n "${TMP_REAP_ROOT:-}" ]; then
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/reap-stale-tmp.js" ]; then
    _str_args=(--budget-min "${TMP_REAP_BUDGET_MIN:-20}" --no-measure)
    [ "$DRY_RUN" = "1" ] && _str_args+=(--dry-run)
    node "$SCRIPT_DIR/lib/reap-stale-tmp.js" ${_str_args[@]+"${_str_args[@]}"} 2>&1 \
      | while IFS= read -r _str_line; do echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $_str_line"; done | tee -a "$LOG" || true
  fi
fi
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
GC_TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gc-merged-worktrees.XXXXXX") || GC_TMP_DIR=""
trap 'rm -rf "$GC_TMP_DIR" 2>/dev/null; rmdir "$GC_LOCK_DIR" 2>/dev/null || rm -rf "$GC_LOCK_DIR" 2>/dev/null' EXIT

# UTC (BRO-2608): see SKIP-RUN comment above — this log is read for
# freshness from a UTC runner, so its timestamps must be TZ-independent.
ts() { date -u '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# Free space on the filesystem holding $1 (default PRIMARY_REPO), in whole GB.
# All repos here live on the same local disk, so one check covers them all.
disk_free_gb() {
  local repo_path="${1:-$PRIMARY_REPO}"
  [ -d "$repo_path" ] || repo_path="$SCRIPT_DIR"
  gc_probe 5 df -Pk "$repo_path" | awk 'NR==2 {print int($4/1024/1024)}'
}

# Detach read probes from the GC's output pipes. A macOS process stuck in
# filesystem I/O may hold them open even after SIGKILL. Never use this for
# removals, which must finish before the shared GC lock is released.
gc_probe() {
  local seconds="$1"; shift
  printf '%s\0' "$@" | python3 "$SCRIPT_DIR/lib/gc-read-probe.py" "$seconds" --stdin
}

gc_pin() {
  # The classifier CLI exits 1 for "none", so call its read-only API and
  # reserve nonzero here for a failed probe or a deadline.
  gc_probe 15 node -e '
    const { cwdPinStatus } = require(process.argv[1]);
    console.log(cwdPinStatus(process.argv[2]).pin);
  ' "$SCRIPT_DIR/lib/gc-worktree-liveness.js" "$1"
}

gc_size_kb() {
  local p="$1" result
  if ! result=$(gc_probe "${WORKTREE_GC_READ_TIMEOUT_SECONDS:-10}" du -sk "$p"); then
    log "WARN  size check failed or timed out — preserving $p" >&2
    return 1
  fi
  [[ "$result" =~ ^[0-9]+[[:space:]] ]] || return 1
  echo "${result%%[!0-9]*}"
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
  hit=$(gc_probe "${WORKTREE_GC_READ_TIMEOUT_SECONDS:-10}" find "$p" \( "${prune_args[@]}" \) -prune -o \
    -type f -newermt "-${days} days" -print -quit) || { log "WARN  age check failed or timed out — preserving $p" >&2; return 1; }
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
# BRO-2607. The real removal path below calls `git worktree remove` with NO
# --force, and git refuses that on ANY dirty tree. The dry-run branch must
# model the same refusal, or a worktree holding uncommitted SOURCE gets
# reported as "fully merged / WOULD-REMOVE" and counted in removed=. Measured
# 2026-08-31 on one machine two minutes apart: dry-run removed=15 skipped=2,
# real run removed=2 skipped=16. 13 of the 15 were iOS worktrees carrying real
# edits (e.g. `M app/(tabs)/watched.tsx`). The GC refusing them was correct;
# the dry-run calling them "fully merged" was the defect. Keep the dry-run's
# three-way split in lockstep with the real path's three outcomes.
#
# BRO-2624: this function is status-only by design — it does NOT need to
# check lock state. `git worktree lock` refuses `git worktree remove`
# unconditionally, even on a clean tree, so that case is handled earlier and
# in common code for both DRY_RUN and the real path (the `is_locked`
# short-circuit above this function's callers), not folded in here. Widening
# this function to also mean "and not locked" would just recreate two
# separate lock predictions to keep in parity — the exact defect this card
# fixed.
is_worktree_clean() {
  local st
  # `|| return 1` is load-bearing: a worktree whose directory was deleted
  # externally is still listed by `git worktree list --porcelain` (the prune
  # runs after this loop), so flush() reaches it and `git status` FAILS with
  # empty output. Treating that as clean would log "fully merged /
  # WOULD-REMOVE" while the real `git worktree remove` errors and logs SKIP —
  # exactly the divergence this whole change exists to remove.
  st=$(gc_probe 15 git --no-optional-locks -C "$1" status --porcelain) || return 1
  [ -z "$st" ]
}

# reports, i.e. tracked-or-untracked-and-not-ignored files — gitignored
# content (review-texts/, subscribers.json, cookies/, etc.) is invisible to
# it either way and is deleted by ANY worktree removal, force or plain; that
# exposure predates this function and is unchanged by it.
#
# BRO-5301: three more kinds of dirt are discardable, each for a stated reason
# (disk sat at 2.7GB with ~12 merged worktrees held by nothing else):
#   - *.pyc / __pycache__/  — bytecode, rebuilt from source (tracked at some
#     old base commits, untracked since .gitignore:579).
#   - data/auto-fix-results.json — auto-fix-show-data.js report output; nothing
#     reads it.
#   - a modified top-level data/*.json whose exact content was COMMITTED at that
#     path on a branch (local or remote) of this repo or of the core-data clone
#     (pre-BRO-5261 setup-local-data.sh copies of core data). Object-DB presence
#     alone is not enough: `git add` + unstage, an aborted hook commit or a stash
#     leaves an unreachable blob for a real edit (ship-check, BRO-5301), so the
#     check is `log --find-object` over --branches --remotes, path-limited.
GC_CORE_DATA_DIR="${WORKTREE_GC_CORE_DATA_DIR:-${HOME:+$HOME/broadway-scorecard-data}}"
is_committed_copy() {
  local p="$1" f="$2" h
  [ -f "$p/$f" ] || return 1
  h=$(gc_probe 10 git -C "$p" hash-object -- "$f") || return 1
  [ -n "$h" ] || return 1
  [ -n "$(gc_probe 15 git -C "$p" log --branches --remotes -1 --format=%H --find-object="$h" -- "$f")" ] && return 0
  [ -n "$GC_CORE_DATA_DIR" ] && [ -d "$GC_CORE_DATA_DIR" ] || return 1
  [ -n "$(gc_probe 15 git -C "$GC_CORE_DATA_DIR" log --branches --remotes -1 --format=%H --find-object="$h" -- "${f#data/}")" ]
}
is_safe_dirty() {
  local p="$1" status line f
  status=$(gc_probe 15 git --no-optional-locks -C "$p" status --porcelain) || return 1
  [ -z "$status" ] && return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    f="${line:3}"
    case "$f" in
      *' -> '*) return 1 ;;
      \"*) return 1 ;;
      data/audit/*) ;;
      *.pyc|*/__pycache__/*) ;;
      data/auto-fix-results.json) ;;
      data/*/*) return 1 ;;
      data/*.json) [ "${line:0:2}" = " M" ] && is_committed_copy "$p" "$f" || return 1 ;;
      *) return 1 ;;
    esac
  done <<< "$status"
  return 0
}

# BRO-4815: scripts/lib/worktree-gc-salvage.js decides (and in copy mode does)
# the salvage of untracked-only notes. stdout = its one-line JSON verdict; exit
# 0 only when eligible (and, without --check-only, copied). Missing node/lib =>
# not eligible, so the old keep-it behaviour is the fallback.
salvage_worktree() {
  command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/worktree-gc-salvage.js" ] || return 1
  node "$SCRIPT_DIR/lib/worktree-gc-salvage.js" --path="$1" "${@:2}" 2>/dev/null
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
      sz=$(gc_size_kb "$p/$d") || continue
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
  sz=$(gc_size_kb "$dd") || return 0
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

# Intentionally web-only emergency disk relief (BRO-2553). The repo list in
# worktree-gc-repos.js scopes worktree and build-artifact GC only; adding a
# repo there must not opt its scratchpads into recursive deletion. iOS
# scratchpads remain outside this policy, even below the disk floor.
LAST_SCRATCHPAD_FREED_KB=0
clean_stale_scratchpad() {
  local total=0 dir sz
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    is_stale "$dir" "$SCRATCHPAD_STALE_DAYS" || continue
    sz=$(gc_size_kb "$dir") || continue
    sz=${sz:-0}
    [ "$sz" = "0" ] && continue
    if [ "$DRY_RUN" = "1" ]; then
      log "WOULD-CLEAN  scratchpad $(basename "$(dirname "$dir")")/$(basename "$dir") — $(human_kb "$sz"), untouched >${SCRATCHPAD_STALE_DAYS}d"
    else
      rm -rf "${dir:?}"
      log "CLEAN  scratchpad $(basename "$(dirname "$dir")")/$(basename "$dir") — freed $(human_kb "$sz"), untouched >${SCRATCHPAD_STALE_DAYS}d"
    fi
    total=$((total + sz))
  done < <(gc_probe 15 find "$PRIMARY_REPO" -maxdepth 3 -type d -name scratchpad -not -path '*/node_modules/*' 2>/dev/null)
  LAST_SCRATCHPAD_FREED_KB=$total
}

# gh CLI's run-log cache (BRO-6430): `gh run view --log*` stores every
# downloaded CI log as ~/.cache/gh/run-log-<id>-<ts>.zip and never expires
# them. It reached 3.6GB (1,400+ zips) during the 2026-10-29..11-02 low-disk
# window that kept dispatch refused; every zip is re-downloadable from
# GitHub on demand. Only run-log zips older than GH_RUN_LOG_STALE_DAYS go
# (find -mtime +N: at least N+1 whole days old) —
# the rest of ~/.cache/gh (API response cache) is left alone.
GH_RUN_LOG_STALE_DAYS="${WORKTREE_GC_GH_RUN_LOG_STALE_DAYS:-7}"
LAST_GH_RUN_LOG_FREED_KB=0
clean_stale_gh_run_logs() {
  local dir="$HOME/.cache/gh" sz
  LAST_GH_RUN_LOG_FREED_KB=0
  [ -d "$dir" ] || return 0
  local sizes
  sizes=$(gc_probe 15 find "$dir" -maxdepth 1 -type f -name 'run-log-*.zip' -mtime +"$GH_RUN_LOG_STALE_DAYS" -exec du -sk '{}' +) || return 0
  sz=$(awk '{s+=$1} END {print s+0}' <<< "$sizes")
  sz=${sz:-0}
  [ "$sz" = "0" ] && return 0
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-CLEAN  gh run-log cache — $(human_kb "$sz"), older than ${GH_RUN_LOG_STALE_DAYS}d"
  else
    find "$dir" -maxdepth 1 -type f -name 'run-log-*.zip' -mtime +"$GH_RUN_LOG_STALE_DAYS" -delete 2>/dev/null
    log "CLEAN  gh run-log cache — freed $(human_kb "$sz"), older than ${GH_RUN_LOG_STALE_DAYS}d"
  fi
  LAST_GH_RUN_LOG_FREED_KB=$sz
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

# Chrome/Chromium code-signing clone cache (BRO-2279): unlike DerivedData
# et al below, this one runs UNCONDITIONALLY every pass, not gated on
# DISK_FLOOR_GB. It grew to 45G and pushed the fleet to 483Mi free between
# hourly floor checks during a dispatch loop (2026-08-21) — waiting for the
# whole-disk floor to be breached before probing it would reproduce the
# exact outage this exists to prevent. Standalone script (also runs as its
# own session-start/cron check) so `scripts/check-chrome-clone-cache.sh` is
# independently testable and callable outside this GC.
check_chrome_clone_cache() {
  local script="$SCRIPT_DIR/check-chrome-clone-cache.sh"
  [ -x "$script" ] || return 0
  local line dry_run_arg=()
  [ "$DRY_RUN" = "1" ] && dry_run_arg=(--dry-run)
  # Bare "${dry_run_arg[@]}" on a zero-element array (every real, non-dry-run
  # invocation) trips "unbound variable" under `set -u` on macOS's /bin/bash
  # (3.2 — the empty-array-expansion bug fixed upstream in bash 4.4). This
  # script is launched by launchd as `/bin/bash .../gc-merged-worktrees.sh`
  # (bypassing the `env bash` shebang — see
  # ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist), so that IS
  # the interpreter every cron run hits. Same fix as BRO-2186 (see the
  # CURRENT_BUILD_ARTIFACT_DIRS comment above): `${arr[@]+"${arr[@]}"}`
  # expands to nothing for a zero-element array instead of dereferencing it.
  while IFS= read -r line; do
    log "$line"
  done < <("$script" "${dry_run_arg[@]+"${dry_run_arg[@]}"}" 2>&1)
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
  [[ "$before" =~ ^[0-9]+$ ]] || { log "WARN  disk free space could not be measured; skipping emergency cleanup"; return 0; }
  if [ "$before" -ge "$DISK_FLOOR_GB" ]; then
    return 0
  fi
  log "ALERT: disk free ${before}GB below floor ${DISK_FLOOR_GB}GB — running emergency cleanup"
  clean_derived_data; floor_freed=$((floor_freed + LAST_CLEAN_DD_FREED_KB))
  clean_stale_scratchpad; floor_freed=$((floor_freed + LAST_SCRATCHPAD_FREED_KB))
  clean_stale_gh_run_logs; floor_freed=$((floor_freed + LAST_GH_RUN_LOG_FREED_KB))
  clean_unavailable_simulators
  after=$(disk_free_gb "$PRIMARY_REPO")
  log "DIGEST: disk-floor cleanup freed $(human_kb "$floor_freed") — free space ${before}GB -> ${after}GB (floor ${DISK_FLOOR_GB}GB)"
  LAST_FLOOR_FREED_KB=$floor_freed
}

check_chrome_clone_cache
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

# Process shared-parser records containing path, branch and lock state.
# Reads $REPO / $CURRENT_REPO_NAME / $CURRENT_BUILD_ARTIFACT_DIRS,
# which gc_one_repo() sets before invoking this per repo.
# Detached temp checkouts leaked by a killed caller (BRO-5364, BRO-8124).
# makeFreshCheckout (acceptance-check-core.js) creates <tmpdir>/<prefix>XXXXXX/main
# with `git worktree add --detach`; a killed caller leaks it, and the
# detached-HEAD SKIP in flush() kept it forever. The decision (known prefix
# under a temp root, dead owner >10m or ownerless idle >60m, nothing open under
# it, clean, HEAD on origin/main) lives in ONE place, reap-temp-checkouts.js,
# which also runs before the lock above. Returns 0 when handled, 1 to fall
# through to SKIP.
reap_stale_tmp_checkout() {
  local wt="$1" out kb reason
  case "$wt" in */main) ;; *) return 1 ;; esac
  [ -f "$SCRIPT_DIR/lib/reap-temp-checkouts.js" ] || return 1
  if [ "$DRY_RUN" = "1" ]; then
    out=$(gc_probe 180 node "$SCRIPT_DIR/lib/reap-temp-checkouts.js" --one "$wt" --dry-run 2>/dev/null) || return 1
  else
    out=$(gc_probe 180 node "$SCRIPT_DIR/lib/reap-temp-checkouts.js" --one "$wt" 2>/dev/null) || return 1
  fi
  kb=$(printf '%s' "$out" | awk '{print $2}')
  case "$kb" in ''|*[!0-9]*) kb=0 ;; esac
  reason=$(printf '%s' "$out" | cut -d' ' -f3-)
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-REMOVE-TMP  [$CURRENT_REPO_NAME] $wt — $reason"
  else
    log "REMOVE-TMP [$CURRENT_REPO_NAME] $wt — freed $(human_kb "$kb"), $reason"
  fi
  removed=$((removed+1))
  removed_freed_kb=$((removed_freed_kb + kb))
  return 0
}

# Stale job worktrees whose branch never landed (BRO-5378). Headless job-*
# worktrees (bsc-runner.js) that end without landing, or whose work landed
# through different commits, were KEPT forever by the unmerged arm below at
# ~1GB each: on 2026-10-14, 48 idle ones held 50GB and / hit 4.7GB free.
# Retired (worktree removed, branch ref KEPT, so no commit is lost) only when
# ALL hold: job-* name, not locked, idle > RETIRE_STALE_DAYS (default 3; was 8
# to outlive dispatch-watchdog.js's 7-day unlanded re-check, which now reads a
# retired job's kept job/<x> ref when its cwd is gone, BRO-8178), the branch ref exists, no process has it as cwd, no live lease,
# and the tree is clean or only generated churn (is_safe_dirty). The caller
# keeps it in the stale digest. Kill switch: WORKTREE_GC_RETIRE_STALE_JOBS=0.
RETIRE_STALE_DAYS="${WORKTREE_GC_RETIRE_STALE_DAYS:-3}"
worktree_inputs_safe() {
  local wt="$1" out
  LAST_INPUTS_REASON=""
  # Git status alone misses ignored settings, nested repositories and data.
  # BRO-8178: the verdict lives in worktree-ignored-inputs.js (symlinks, empty
  # dirs, caches, setup-local-data copies and files identical to the main
  # checkout are disposable; anything else keeps). The old inline allowlist
  # kept every bootstrapped worktree. Missing helper or a probe failure keeps.
  [ -f "$SCRIPT_DIR/lib/worktree-ignored-inputs.js" ] || return 1
  out=$(gc_probe 60 node "$SCRIPT_DIR/lib/worktree-ignored-inputs.js" --worktree="$wt" --main="$REPO") || {
    LAST_INPUTS_REASON="(probe unavailable)"; return 1; }
  case "$out" in
    ok) return 0 ;;
    "discards setup copies:"*) log "NOTE  [$CURRENT_REPO_NAME] $(basename "$wt") — $out"; return 0 ;;
    "keeps: "*) LAST_INPUTS_REASON="(${out})"; return 1 ;;
    *) LAST_INPUTS_REASON="(probe unavailable)"; return 1 ;;
  esac
}

retire_stale_job_worktree() {
  local wt="$1" br="$2" pin how sz saved_head
  [ "${WORKTREE_GC_RETIRE_STALE_JOBS:-1}" = "0" ] && return 1
  case "$(basename "$wt")" in job-*) ;; *) return 1 ;; esac
  [ "$is_locked" = "1" ] && return 1
  saved_head=$(gc_probe 10 git rev-parse --verify "refs/heads/$br^{commit}") || return 1
  [ "$saved_head" = "$(gc_probe 10 git -C "$wt" rev-parse HEAD)" ] || return 1
  is_stale "$wt" "$RETIRE_STALE_DAYS" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}" || return 1
  command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/gc-worktree-liveness.js" ] || return 1
  pin=$(gc_pin "$wt") || return 1
  [ "$pin" = "none" ] || return 1
  if is_worktree_clean "$wt"; then how="clean"
  elif is_safe_dirty "$wt"; then how="generated churn only"
  else return 1
  fi
  worktree_inputs_safe "$wt" || return 1
  sz=$(gc_size_kb "$wt") || return 1
  sz=${sz:-0}
  if [ "$DRY_RUN" = "1" ]; then
    log "WOULD-RETIRE  [$CURRENT_REPO_NAME] $(basename "$wt") — $br unmerged, idle >${RETIRE_STALE_DAYS}d, $how; branch would be kept"
  else
    # Slow inputs probe first; the lease and tip re-checks sit right before
    # the remove (a resumed job may have taken it during the probe).
    worktree_inputs_safe "$wt" || return 1
    if [ -f "$SCRIPT_DIR/lib/worktree-live-lease-check.js" ]; then
      gc_probe 10 node "$SCRIPT_DIR/lib/worktree-live-lease-check.js" --path="$wt" >/dev/null 2>&1
      [ "$?" = "1" ] || return 1
    fi
    [ "$saved_head" = "$(gc_probe 10 git rev-parse --verify "refs/heads/$br^{commit}")" ] || return 1
    if [ "$how" = "clean" ]; then
      LC_ALL=C git worktree remove "$wt" >/dev/null 2>&1 || return 1
    else
      LC_ALL=C git worktree remove --force "$wt" >/dev/null 2>&1 || return 1
    fi
    log "REMOVE [$CURRENT_REPO_NAME] $(basename "$wt") — retired: $br unmerged, idle >${RETIRE_STALE_DAYS}d, $how; branch kept (BRO-5378)"
  fi
  removed=$((removed+1))
  removed_freed_kb=$((removed_freed_kb + sz))
  return 0
}

path="" branch="" is_locked=0 locked_reason=""
flush() {
  [ -z "$path" ] && return
  # Skip the main checkout.
  if [ "$path" = "$REPO" ]; then path="" branch=""; return; fi
  if [ -z "$branch" ]; then
    if [ "$is_locked" != "1" ] && reap_stale_tmp_checkout "$path"; then
      path="" branch=""; return
    fi
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
  head_sha=$(gc_probe 10 git rev-parse "$branch")
  landed_status=1
  if [ -n "$head_sha" ]; then
    if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/landing-verify.js" ]; then
      PUSH_SKIP_UNSHALLOW=1 gc_probe 15 node "$SCRIPT_DIR/lib/landing-verify.js" --sha="$head_sha" --branch=main --remote=origin --cwd="$REPO" >/dev/null 2>&1
      landed_status=$?
    else
      gc_probe 10 git merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null
      landed_status=$?
    fi
  fi
  if [ -n "$head_sha" ] && [ "$landed_status" = "0" ]; then
    cherry_raw=""      # definitively contained in origin/main
    cherry_status=0
  else
    cherry_raw=$(gc_probe 15 git cherry origin/main "$branch")
    cherry_status=$?
  fi
  if [ "$cherry_status" != "0" ]; then
    log "WARN  [$CURRENT_REPO_NAME] $(basename "$path") — git cherry timed out/failed (exit $cherry_status); treating as unmerged (safety default; job-* worktrees still get the rebase-landed check)"
    unmerged=1
  else
    unmerged=$(echo "$cherry_raw" | grep -c '^+')
  fi
  local is_ancestor has_unmerged has_live_lease removable cwd_pin worktree_idle pin_blocked decide_rc rebase_out rebase_landed=0
  is_ancestor=0
  [ "$landed_status" = "0" ] && is_ancestor=1
  has_unmerged=0
  [ "$unmerged" != "0" ] && has_unmerged=1

  # BRO-8178: land.yml rebases job branches, so a landed job's shas are never
  # ancestors of origin/main and a patch changed during conflict resolution
  # shows '+' in git cherry. 37 finished job worktrees (~800MB each) sat as
  # "unmerged" forever. Runs whether or not git cherry finished: cherry times
  # out most often on exactly these diverged rebased branches, and the check
  # is its own rev-list + byte-identical content test that fails toward KEEP
  # (second-opinion 2026-11-23). A landed verdict then takes the ordinary merged
  # path below (lease, pin, lock, ignored-input and dirty checks unchanged,
  # branch ref kept). Kill switch: WORKTREE_GC_REBASE_LANDED=0.
  if [ "$has_unmerged" = "1" ] && [ "${WORKTREE_GC_REBASE_LANDED:-1}" != "0" ] \
      && [ -f "$SCRIPT_DIR/lib/headless-unlanded-detection.js" ]; then
    case "$(basename "$path")" in
      job-*)
        if rebase_out=$(gc_probe 30 node "$SCRIPT_DIR/lib/headless-unlanded-detection.js" --branch-landed \
            --repo="$REPO" --branch="$branch" --tips-file="${GC_LANDING_TIPS_FILE:-}"); then
          case "$rebase_out" in
            "landed "*)
              # An empty head_sha (rev-parse timed out) would make the
              # pre-removal tip re-check compare "" with "" and pass.
              if [ -z "$head_sha" ]; then
                log "NOTE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch rebase-landed but its tip was unreadable; keeping (BRO-8178)"
              else
                log "NOTE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch rebase-landed: ${rebase_out#landed } (BRO-8178)"
                has_unmerged=0; unmerged=0; rebase_landed=1
              fi ;;
          esac
        fi ;;
    esac
  fi

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
    gc_probe 10 node "$SCRIPT_DIR/lib/worktree-live-lease-check.js" --path="$path" >/dev/null 2>&1
    [ "$?" = "1" ] || has_live_lease=1
  else
    log "WARN  live-lease guard unavailable (node or worktree-live-lease-check.js missing) — skipping for [$CURRENT_REPO_NAME] $(basename "$path")"
  fi

  # BRO-2694: who pins this worktree's cwd. Only gathered when the merge state
  # could allow removal (an unmerged branch is KEEP whatever pins it), because
  # each call snapshots every process via lsof + ps. The classifier prints the
  # bare class on line 1; ANYTHING other than a known class (helper missing,
  # node missing, crash, usage error) reads as 'unknown' = keep. Stricter than
  # the pre-BRO-2694 guard, where a missing/crashing helper meant "clear".
  cwd_pin="none"
  worktree_idle=0
  if [ "$is_ancestor" = "1" ] || [ "$has_unmerged" = "0" ]; then
    cwd_pin="unknown"
    if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/gc-worktree-liveness.js" ]; then
      cwd_pin=$(gc_pin "$path") || cwd_pin="unknown"
    else
      log "WARN  liveness guard unavailable (node or gc-worktree-liveness.js missing) — treating [$CURRENT_REPO_NAME] $(basename "$path") as pinned"
    fi
    case "$cwd_pin" in
      none|stale-process|live-session|foreign-process|unknown) ;;
      *) cwd_pin="unknown" ;;
    esac
    # Idle gate for the stale-process class: no source file touched for
    # STALE_DAYS (same exclusions as the strip/digest staleness check).
    if [ "$cwd_pin" = "stale-process" ] && is_stale "$path" "$STALE_DAYS" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"; then
      worktree_idle=1
    fi
  fi

  # Single decision point (worktree-gc-decide.js -> decideWorktreeReclaim in
  # scripts/lib/worktree-gc-reclaim.js): the signals gathered above
  # (ancestor check, unmerged count, live-lease scan, cwd pin + idleness) all
  # funnel through the SAME function its unit tests exercise, instead of bash
  # re-deciding with its own parallel `if` chain. Exit 0 = removable,
  # 3 = blocked only by the cwd pin, anything else = not removable.
  removable=1
  pin_blocked=0
  if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/worktree-gc-decide.js" ]; then
    node "$SCRIPT_DIR/lib/worktree-gc-decide.js" \
      --is-ancestor="$is_ancestor" --has-unmerged="$has_unmerged" --has-live-lease="$has_live_lease" \
      --cwd-pin="$cwd_pin" --worktree-idle="$worktree_idle" >/dev/null 2>&1
    decide_rc=$?
    [ "$decide_rc" != "0" ] && removable=0
    [ "$decide_rc" = "3" ] && pin_blocked=1
  else
    log "WARN  decision helper unavailable (node or worktree-gc-decide.js missing) — falling back to unmerged-only check, any cwd pin keeps"
    [ "$has_unmerged" = "1" ] && removable=0
    if [ "$removable" = "1" ] && [ "$cwd_pin" != "none" ]; then
      removable=0; pin_blocked=1
    fi
  fi

  if [ "$has_live_lease" = "1" ]; then
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch has a live job-lease using this worktree as its cwd"
    skipped=$((skipped+1))
    path="" branch=""; return
  fi

  # Liveness guard (task #1709, narrowed by BRO-2694): a merged worktree that
  # a live process has as its cwd (a claude session, a terminal, an editor,
  # or an orphan too young / a worktree touched too recently) is never pulled
  # out from under it. Only an ORPHANED, >=24h-old, non-session process tree
  # rooted in a worktree untouched for STALE_DAYS is reclaimed (see
  # classifyCwdPin). Never kills a process and never adds --force.
  if [ "$pin_blocked" = "1" ]; then
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged but a live process has this worktree as its cwd ($cwd_pin)"
    skipped=$((skipped+1))
    path="" branch=""; return
  fi

  if [ "$removable" != "1" ]; then
    if retire_stale_job_worktree "$path" "$branch"; then
      stale_unmerged+=("$CURRENT_REPO_NAME/$(basename "$path")(retired,branch:$branch)")
      path="" branch=""; return
    fi
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
  if [ "$cwd_pin" = "stale-process" ]; then
    log "NOTE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged; cwd pinned only by an orphaned idle non-session process tree, reclaiming (BRO-2694)"
  fi
  # Lock guard (BRO-2624): `git worktree lock` is an explicit human "leave this
  # alone" — `git worktree remove` (with or without --force) refuses on a
  # locked worktree regardless of cleanliness, so this must be checked BEFORE
  # the dry-run/real split below, not folded into the dirty-tree else-branch
  # each side reaches independently. Sharing one check point for both DRY_RUN
  # and the real path is what keeps them in parity here: there is no separate
  # "is it locked" prediction to drift out of sync with the real refusal, the
  # way is_worktree_clean()'s status-only view did (see its header comment).
  if [ "$is_locked" = "1" ]; then
    log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged but worktree is LOCKED (${locked_reason:-no reason given}); not forcing"
    skipped=$((skipped+1))
    path="" branch=""; is_locked=0; locked_reason=""; return
  fi
  if ! worktree_inputs_safe "$path"; then
    log "KEEP  [$CURRENT_REPO_NAME] $(basename "$path") — local inputs ${LAST_INPUTS_REASON:-or probe unavailable}"
    kept=$((kept+1)); path="" branch=""; return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    # Three-way, mirroring the real path's three outcomes exactly (BRO-2607):
    # clean -> plain remove succeeds; safe-dirty -> --force path; anything else
    # -> git refuses and the run logs SKIP. A dirty-source worktree must NOT be
    # counted in removed=, or the dry-run overstates reclaimable headroom.
    if is_worktree_clean "$path"; then
      log "WOULD-REMOVE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch fully merged"
      removed=$((removed+1))
    elif is_safe_dirty "$path"; then
      log "WOULD-FORCE-REMOVE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, only generated churn dirty"
      removed=$((removed+1))
    elif salvage_out=$(salvage_worktree "$path" --check-only); then
      log "WOULD-SALVAGE-REMOVE  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, only untracked notes dirty; would copy to salvage dir ($salvage_out)"
      removed=$((removed+1))
    else
      log "WOULD-SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — merged but worktree dirty; not forcing"
      skipped=$((skipped+1))
      # Mirror the real SKIP arm's stale-artifact strip so freed= predicts the
      # real run here too (strip_build_artifacts logs WOULD-STRIP and does not
      # delete when DRY_RUN=1).
      if is_stale "$path" "$STALE_DAYS" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"; then
        strip_build_artifacts "$path" "${CURRENT_BUILD_ARTIFACT_DIRS[@]+"${CURRENT_BUILD_ARTIFACT_DIRS[@]}"}"
        strip_freed_kb=$((strip_freed_kb + LAST_STRIP_FREED_KB))
      fi
    fi
    path="" branch=""; return
  fi
  # Measured before removal so the DONE summary's freed= reflects what
  # actually left disk, not just the floor/strip/orphan side-cleanups (task
  # #1682: a run that reclaimed 26GB across dozens of worktree removals
  # logged "freed=797.9MB" because this size was never captured — accurate
  # for the wrong reason next time someone reads this log to judge impact).
  local removal_sz remove_err force_err diag_err salvage_out
  removal_sz=$(gc_size_kb "$path") || { skipped=$((skipped+1)); path="" branch=""; return; }
  removal_sz=${removal_sz:-0}
  # BRO-8178: a rebase-landed job worktree is one a resumed job may pick up
  # again (bsc-runner.js takes its lease independently of this GC). Re-check
  # the lease and the branch tip right before removing, as the retire path does.
  if [ "$rebase_landed" = "1" ]; then
    # Slow inputs probe first, so the lease/tip re-check sits right before
    # the remove (same order as retire_stale_job_worktree).
    if ! worktree_inputs_safe "$path"; then
      log "KEEP  [$CURRENT_REPO_NAME] $(basename "$path") — local inputs ${LAST_INPUTS_REASON:-or probe unavailable}"
      kept=$((kept+1)); path="" branch=""; return
    fi
    local lease_rc=0
    if [ -f "$SCRIPT_DIR/lib/worktree-live-lease-check.js" ]; then
      gc_probe 10 node "$SCRIPT_DIR/lib/worktree-live-lease-check.js" --path="$path" >/dev/null 2>&1
      lease_rc=$?
    fi
    if [ "$lease_rc" != "1" ] || [ "$head_sha" != "$(gc_probe 10 git rev-parse "$branch")" ]; then
      log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch rebase-landed but a job resumed or moved the branch since the check; not removing"
      skipped=$((skipped+1)); path="" branch=""; return
    fi
  fi
  # Plain remove (NO --force): git refuses if the working tree is dirty.
  # Stderr is captured (not discarded) so the else-branch below can tell a
  # real refusal reason apart from a bare assumption of dirtiness. LC_ALL=C
  # pins git's fatal: message to English regardless of the operator's locale
  # — the case match below is a substring match on that wording, and a
  # localized message would silently fall through to "not removable" instead
  # of correctly identifying dirty/locked.
  if remove_err=$(LC_ALL=C git worktree remove "$path" 2>&1); then
    log "REMOVE [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, worktree removed (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
  elif is_safe_dirty "$path" && force_err=$(LC_ALL=C git worktree remove --force "$path" 2>&1); then
    # Only reached when the branch is already fully merged AND every dirty
    # path is generated data/ churn (is_safe_dirty) — this is what makes
    # --force safe here despite the file header's "never uses --force" claim
    # for the general case. Without this, merged branches sit forever behind
    # trivial cron-written diffs to data/audit/*.json (task #1682: 51/56
    # dirty worktrees were stuck this way, gc reporting freed=0KB run after
    # run while disk hit 99% full).
    log "FORCE-REMOVE [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, discarded uncommitted generated churn (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
  elif case "$remove_err" in *"locked"*) false ;; *) true ;; esac \
      && salvage_out=$(salvage_worktree "$path") \
      && force_err=$(LC_ALL=C git worktree remove --force "$path" 2>&1); then
    # BRO-4815: landed + only untracked session notes dirty. The notes were
    # copied to the salvage dir by the CLI first (it refuses on any tracked
    # change, symlink, big file, recent write or open handle). Single --force,
    # never -f -f; locked worktrees were skipped above and a lock seen in the
    # plain-remove error skips salvage so we never copy without removing.
    log "SALVAGE-REMOVE [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged, untracked notes copied ($salvage_out), worktree removed (branch kept)"
    removed=$((removed+1))
    removed_freed_kb=$((removed_freed_kb + removal_sz))
  else
    # BRO-2624: `git worktree remove` fails for more reasons than a dirty tree
    # (the LOCKED case is already preempted above, but a lock race between
    # that check and this remove call — or a submodule/permissions error —
    # can still land here). Read the actual git error instead of assuming
    # dirtiness, so the committed audit log names the real cause. Diagnose
    # off the LAST attempt that actually ran: when is_safe_dirty took the
    # --force branch and force_err came back non-empty, that failure (not the
    # first plain-remove's "dirty" refusal) is why the worktree survives —
    # e.g. it got locked in the gap between the two `git worktree remove`
    # calls, which would otherwise still be misreported as plain dirtiness.
    diag_err="${force_err:-$remove_err}"
    case "$diag_err" in
      *"is locked"*|*"cannot remove a locked working tree"*)
        log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — $branch merged but worktree is LOCKED (locked between dry-run check and removal); not forcing" ;;
      *"contains modified or untracked files"*)
        log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — merged but worktree dirty; not forcing" ;;
      *)
        log "SKIP  [$CURRENT_REPO_NAME] $(basename "$path") — merged but not removable (${diag_err:-unknown error}); not forcing" ;;
    esac
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
  # BRO-7325: git worktree list reports resolved paths, so compare against the
  # resolved repo path too. Through a symlink, the main-checkout skip and the
  # orphan sweep's is_registered check would otherwise never match.
  REPO="$(pwd -P)"

  if [ -n "$TIMEOUT_BIN" ]; then
    # unbounded-fetch-ok: bounded by $TIMEOUT_BIN 20s; see file header.
    "$TIMEOUT_BIN" 20s git fetch origin main -q 2>/dev/null || log "WARN: [$repo_name] git fetch failed or timed out (offline?) — using cached origin/main"
  else
    # unbounded-fetch-ok: only reached when timeout/gtimeout is absent (rare local machine); see file header.
    git fetch origin main -q 2>/dev/null || log "WARN: [$repo_name] git fetch failed (offline?) — using cached origin/main"
  fi

  # BRO-8178: landings.jsonl tips, read once per repo run for the rebase-proof
  # landed check in flush(). Empty file = signal 1 unavailable (content tie
  # still runs); a failed write leaves the check to fall back to keeping.
  GC_LANDING_TIPS_FILE=""
  if [ -n "$GC_TMP_DIR" ] && [ -f "$SCRIPT_DIR/lib/headless-unlanded-detection.js" ]; then
    GC_LANDING_TIPS_FILE="$GC_TMP_DIR/landing-tips-$repo_name.txt"
    : > "$GC_LANDING_TIPS_FILE"
    gc_probe 60 node "$SCRIPT_DIR/lib/headless-unlanded-detection.js" --repo="$REPO" --write-tips="$GC_LANDING_TIPS_FILE" >/dev/null \
      || log "WARN  [$repo_name] landings.jsonl tips unavailable; rebase-landed detection uses the content check only"
  fi

  local worktree_list
  if ! worktree_list=$(gc_probe 15 git worktree list --porcelain); then
    log "WARN  [$repo_name] worktree list unavailable; preserving this repository"
    return
  fi
  path="" branch="" is_locked=0 locked_reason=""
  # Same parser as check-worktree-collision.js. NUL fields preserve empty
  # branches/reasons and spaces without a second porcelain parser in bash.
  while IFS= read -r -d '' path &&
        IFS= read -r -d '' branch &&
        IFS= read -r -d '' is_locked &&
        IFS= read -r -d '' locked_reason; do
    flush
  done < <(printf '%s\n\n' "$worktree_list" | node "$SCRIPT_DIR/lib/worktree-lock-parse.js")

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
    # Refresh after the mutation pass. Never infer orphans from a failed list.
    if ! worktree_list=$(gc_probe 15 git worktree list --porcelain); then
      log "WARN  [$repo_name] worktree list unavailable; preserving possible orphans"
      return
    fi
    while IFS= read -r reg_line; do
      case "$reg_line" in
        "worktree "*) registered_paths+=("${reg_line#worktree }") ;;
      esac
    done <<< "$worktree_list"
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
      local recent
      recent=$(gc_probe "${WORKTREE_GC_READ_TIMEOUT_SECONDS:-10}" find "$dir" -newermt '-15 minutes' -print -quit) || continue
      [ -z "$recent" ] || continue
      orphan_sz=$(gc_size_kb "$dir") || continue
      orphan_sz=${orphan_sz:-0}
      if [ "$DRY_RUN" = "1" ]; then
        log "WOULD-REMOVE-ORPHAN  [$repo_name] $orphan_name — $(human_kb "$orphan_sz"), not registered with git worktree list"
      else
        rm -rf "${dir:?}"
        log "REMOVE-ORPHAN  [$repo_name] $orphan_name — freed $(human_kb "$orphan_sz"), not registered with git worktree list"
      fi
      orphan_freed_kb=$((orphan_freed_kb + orphan_sz))
    done < <(gc_probe 15 find "$worktrees_root" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
  fi

  if [ "${#stale_unmerged[@]}" -gt 0 ]; then
    log "DIGEST[$repo_name]: ${#stale_unmerged[@]} unmerged worktree(s) untouched >${STALE_DAYS}d holding stranded work: ${stale_unmerged[*]:-}"
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

# BRO-8178: publish free disk, worktree count and top consumers for the
# GitHub-sent morning digest (mac/disk commit status, throttled to 6h inside
# the helper). Real runs on the real repos only: never from a dry run or a
# fixture (WORKTREE_GC_REPOS_JSON set). Off: WORKTREE_GC_POST_DISK=0.
if [ "$DRY_RUN" = "0" ] && [ -z "${WORKTREE_GC_REPOS_JSON:-}" ] && [ "${WORKTREE_GC_POST_DISK:-1}" != "0" ] \
    && command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/lib/mac-disk-digest.js" ]; then
  if [ -n "$TIMEOUT_BIN" ]; then
    disk_post=$("$TIMEOUT_BIN" 300s node "$SCRIPT_DIR/lib/mac-disk-digest.js" --post --repo="$PRIMARY_REPO" 2>&1)
  else
    disk_post=$(node "$SCRIPT_DIR/lib/mac-disk-digest.js" --post --repo="$PRIMARY_REPO" 2>&1)
  fi
  log "DISK  ${disk_post:-mac/disk post produced no output}"
fi
