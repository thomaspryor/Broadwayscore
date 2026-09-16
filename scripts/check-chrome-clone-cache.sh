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
#
# Fail-open by design (same contract as scripts/lib/disk-floor-check.sh): a
# missing/unreadable /var/folders tree or a `du`/`find` hiccup must never
# crash the caller (launchd cron or session-start hook) — this is a
# best-effort proactive prune, not a gate.

set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

FLOOR_GB="${CHROME_CLONE_CACHE_FLOOR_GB:-5}"
FLOOR_KB="${CHROME_CLONE_CACHE_FLOOR_KB:-$((FLOOR_GB * 1024 * 1024))}"
SEARCH_ROOT="${CHROME_CLONE_CACHE_SEARCH_ROOT:-/var/folders}"

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

# depth: /var/folders/<XX>/<hash>/X/com.google.Chrome.code_sign_clone — 4
# levels below /var/folders. -iname is case-insensitive defensively; the
# directory name itself is stable across macOS versions.
while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  found_any=1
  sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
  sz=${sz:-0}
  if [ "$sz" -lt "$FLOOR_KB" ] 2>/dev/null; then
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "WOULD-PRUNE  $dir — $(human_kb "$sz") (floor ${FLOOR_GB}GB)"
    continue
  fi
  rm -rf "${dir:?}"/* 2>/dev/null
  after=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
  after=${after:-0}
  echo "PRUNED  $dir — freed $(human_kb $((sz - after))) (floor ${FLOOR_GB}GB, now $(human_kb "$after"))"
  if [ "$after" -ge "$FLOOR_KB" ] 2>/dev/null; then
    echo "WARN  $dir still >= ${FLOOR_GB}GB after prune — Chrome may hold files open, will retry next run" >&2
    exit_code=1
  fi
done < <(find "$SEARCH_ROOT" -maxdepth 4 -type d -iname 'com.google.Chrome.code_sign_clone' 2>/dev/null)

[ "$found_any" = "0" ] && echo "check-chrome-clone-cache: no com.google.Chrome.code_sign_clone dirs found"

exit "$exit_code"
