#!/usr/bin/env bash
# merge-script-staleness.sh — the self-staleness decision for
# scripts/merge-worktree-to-main.sh (BRO-3873 step 4, reviewer P0).
#
# WHY: a worktree branched BEFORE a change to the landing script carries the
# OLD copy of it, and sessions run the copy in their own worktree
# (`bash scripts/merge-worktree-to-main.sh`). With ~20 open worktrees, an
# old copy would keep merging into the SHARED main checkout for weeks after
# the land/** path shipped. So the script compares its own version against
# origin/main's copy at startup and, when origin's is NEWER (or this is a
# detached copy with no lib dir next to it), re-execs origin/main's copy
# with the same arguments.
#
# VERSION, NOT BYTES (learned the hard way, 2026-09-20): a byte comparison
# defers to origin/main even when origin's copy is OLDER — e.g. the very
# branch that ships a new version of this script. That first dry run
# re-exec'd the pre-change copy, which merged the WIP branch into the shared
# main checkout — the exact behaviour the change retires. Each copy carries
# a `MERGE_SCRIPT_VERSION=N` line; a copy without one is version 0. Bump N
# whenever the landing behaviour changes.
#
# Pure decision, no git calls — the caller hands in two file paths. Sourced
# by the merge script; exercised (via bash) by the colocated test.
#
#   merge_script_version <file>            prints the copy's MERGE_SCRIPT_VERSION (0 if absent)
#   merge_script_staleness_decision <local-copy> <origin-copy> [<local-lib-dir>]
#   prints exactly one of:
#     reexec                  origin/main's copy is newer (or ours is detached and origin's is ≥ ours)
#     current                 ours is the same or a newer version, with its lib dir present
#     skip:no-origin-copy     origin/main's copy could not be read (offline, fixture repo, path deleted)
#     skip:origin-older       detached copy, and origin/main's is OLDER than ours — nothing usable to re-exec
#     skip:already-reexeced   MERGE_SCRIPT_REEXECED=1 — we ARE the re-exec'd copy (loop guard)
#     skip:disabled           MERGE_SCRIPT_NO_REEXEC=1 — operator opt-out
#
# Exit status is always 0; the decision is the printed token.

merge_script_version() {
  local f="${1:-}" v
  [ -n "$f" ] && [ -f "$f" ] || { echo 0; return 0; }
  v=$(grep -m1 -E '^MERGE_SCRIPT_VERSION=[0-9]+' "$f" 2>/dev/null | sed -E 's/^MERGE_SCRIPT_VERSION=([0-9]+).*/\1/')
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
  return 0
}

merge_script_staleness_decision() {
  local local_copy="${1:-}" origin_copy="${2:-}" lib_dir="${3:-}" lv ov detached=0
  if [ "${MERGE_SCRIPT_REEXECED:-}" = "1" ]; then echo "skip:already-reexeced"; return 0; fi
  if [ "${MERGE_SCRIPT_NO_REEXEC:-}" = "1" ]; then echo "skip:disabled"; return 0; fi
  if [ -z "$origin_copy" ] || [ ! -s "$origin_copy" ]; then echo "skip:no-origin-copy"; return 0; fi
  # A copy run from a temp file or process substitution has no scripts/lib
  # beside it — it cannot source its own dependencies, so it must be
  # re-materialised from origin/main whenever origin's copy is usable.
  if [ -n "$lib_dir" ] && [ ! -d "$lib_dir" ]; then detached=1; fi
  [ -n "$local_copy" ] && [ -f "$local_copy" ] || detached=1
  lv=$(merge_script_version "$local_copy")
  ov=$(merge_script_version "$origin_copy")
  if [ "$ov" -gt "$lv" ]; then echo "reexec"; return 0; fi
  if [ "$detached" = 1 ]; then
    if [ "$ov" -ge "$lv" ]; then echo "reexec"; else echo "skip:origin-older"; fi
    return 0
  fi
  echo "current"
  return 0
}
