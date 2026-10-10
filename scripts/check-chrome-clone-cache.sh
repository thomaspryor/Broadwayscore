#!/usr/bin/env bash
#
# check-chrome-clone-cache.sh (BRO-2279)
#
# macOS accumulates `com.google.Chrome.code_sign_clone` under
# /var/folders/**/X/ from repeated Chrome auto-update code-signing clones
# that the OS fails to garbage-collect. On 2026-08-21 this grew to 45G and
# silently pushed the fleet's disk to 483Mi free mid-dispatch-loop — a
# DIFFERENT root cause than BRO-2258 (bsc-jobs log growth), which the
# already-sanctioned prune commands (bsc-jobs logs + claude-501 tmp) did not
# touch. Deleting it is safe: Chrome regenerates the clone on demand, and it
# holds no project data — deleting it live-freed disk to 7.4Gi in the
# original incident.
#
# Matches `*.code_sign_clone` generically, not just Chrome's: `code_sign_clone`
# is an OS-level Gatekeeper artifact name, not app-specific logic, so the same
# GC failure plausibly hits any codesigned app's auto-update clone — and
# com.brave.Browser.code_sign_clone is in fact present under the same parent
# dir on this machine (448M as of 2026-09-16), though only Chrome's has been
# incident-verified as safe-to-delete-and-regenerates. The staleness gate,
# fail-open handling, /var/folders scope, and kill switch below all still
# apply per-directory regardless of which app it belongs to, so the blast
# radius of extending the match is bounded even without per-app verification.
#
# Usage:
#   scripts/check-chrome-clone-cache.sh              # prune anything over the floor
#   scripts/check-chrome-clone-cache.sh --dry-run     # report only, change nothing
#
# Env:
#   CHROME_CLONE_CACHE_FLOOR_GB=5     # override the trigger threshold (default 5GB)
#   CHROME_CLONE_CACHE_FLOOR_KB       # test seam only — sub-GB threshold override
#                                      # (bash arithmetic below is integer-only, so
#                                      # fractional-GB fixtures can't be expressed
#                                      # via CHROME_CLONE_CACHE_FLOOR_GB alone;
#                                      # production never sets this).
#   CHROME_CLONE_CACHE_SEARCH_ROOT    # test seam only — override the /var/folders
#                                      # search root so tests can point this at a
#                                      # fixture dir instead of the real machine
#                                      # (production never sets this).
#   CHROME_CLONE_CACHE_DISABLED=true  # kill switch — same convention as
#                                      # DEPLOY_GATE_DISABLED (scripts/lib/
#                                      # should-deploy-gate.js). Fast rollback
#                                      # path if this ever needs to stop
#                                      # touching /var/folders without editing
#                                      # or un-executabling the script itself.
#
# Fail-open by design (same contract as scripts/lib/disk-floor-check.sh): a
# missing/unreadable /var/folders tree or a `du`/`find` hiccup must never
# crash the caller (launchd cron or session-start hook) — this is a
# best-effort proactive prune, not a gate.
#
# No locking: this script (and the gc-merged-worktrees.sh cron call into it)
# can run concurrently with a manual invocation. That's safe by
# construction — pruning is idempotent (rm -rf on an already-gone/already-
# empty dir is a no-op) and destroys nothing but a regenerable OS cache, so
# a race produces at worst duplicate log lines, never corruption.

set -uo pipefail

[ "${CHROME_CLONE_CACHE_DISABLED:-}" = "true" ] && exit 0

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

FLOOR_GB="${CHROME_CLONE_CACHE_FLOOR_GB:-5}"
FLOOR_KB="${CHROME_CLONE_CACHE_FLOOR_KB:-$((FLOOR_GB * 1024 * 1024))}"
SEARCH_ROOT="${CHROME_CLONE_CACHE_SEARCH_ROOT:-/var/folders}"
# Skip a dir that's still being written to — Chrome/its updater may be mid
# code-signing-clone. `-mmin +2`-equivalent staleness check (find's own
# -mmin, not a second `stat` shellout) on the dir's own mtime: a clone
# actively being populated keeps bumping its parent dir's mtime as entries
# are added/removed within it.
STALE_MIN="${CHROME_CLONE_CACHE_STALE_MIN:-2}"

human_kb() {
  local kb="${1:-0}"
  if [ "$kb" -ge 1048576 ] 2>/dev/null; then
    awk -v kb="$kb" 'BEGIN { printf "%.1fG", kb/1048576 }'
  else
    awk -v kb="$kb" 'BEGIN { printf "%.0fM", kb/1024 }'
  fi
}

found_any=0
exit_code=0

# depth: /var/folders/<XX>/<hash>/X/<bundle-id>.code_sign_clone — 4 levels
# below /var/folders. -iname is case-insensitive defensively; the
# `*.code_sign_clone` suffix is the stable, OS-defined part across macOS
# versions and across which app it belongs to.
while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  found_any=1
  sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
  sz=${sz:-0}
  if [ "$sz" -lt "$FLOOR_KB" ] 2>/dev/null; then
    continue
  fi
  floor_display="$(human_kb "$FLOOR_KB")"
  # Skip anything modified within STALE_MIN minutes — an in-progress clone
  # keeps bumping its own dir mtime, so this defers pruning until the next
  # run rather than risk deleting out from under an active Chrome update.
  if [ -z "$(find "$dir" -maxdepth 0 -mmin "+$STALE_MIN" 2>/dev/null)" ]; then
    echo "SKIP  $dir — $(human_kb "$sz") over floor but modified <${STALE_MIN}m ago, deferring to next run"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "WOULD-PRUNE  $dir — $(human_kb "$sz") (floor ${floor_display})"
    continue
  fi
  # Delete the whole matched dir, not just its contents: `rm -rf "$dir"/*`
  # would silently skip dotfiles (no dotglob), understating what's freed and
  # leaving the dir stuck above the floor forever if Chrome ever drops one
  # in there. Chrome recreates the dir itself on its next code-signing
  # clone, same "safe to delete, regenerates" contract as the rest of this
  # script.
  rm -rf "${dir:?}" 2>/dev/null
  after=0
  [ -e "$dir" ] && after=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
  after=${after:-0}
  echo "PRUNED  $dir — freed $(human_kb $((sz - after))) (floor ${floor_display}, now $(human_kb "$after"))"
  if [ "$after" -ge "$FLOOR_KB" ] 2>/dev/null; then
    echo "WARN  $dir still >= ${floor_display} after prune — the app may hold files open, will retry next run" >&2
    exit_code=1
  fi
done < <(find "$SEARCH_ROOT" -maxdepth 4 -type d -iname '*.code_sign_clone' 2>/dev/null)

[ "$found_any" = "0" ] && echo "check-chrome-clone-cache: no *.code_sign_clone dirs found"

exit "$exit_code"
