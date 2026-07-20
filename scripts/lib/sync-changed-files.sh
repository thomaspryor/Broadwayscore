#!/usr/bin/env bash
# Copies only the files under SRC_DIR that differ from their counterpart in
# SNAPSHOT_DIR (byte comparison via cmp) into DEST_DIR. A file identical to
# its snapshot is skipped — it was never touched by whatever wrote SRC_DIR
# this run, so copying it back would push stale content and revert any
# concurrent writer's changes to that same file (P0 2026-07-13 push-core-data
# incident; scripts/lib/core-data-sync-decision.js pins the same per-file
# decision table for the fixed-file-list variant of this problem).
#
# Deletion propagation (--allow-delete, default OFF): a file present in
# SNAPSHOT_DIR but missing from SRC_DIR means this run deleted it — UNLESS
# SRC_DIR is also subject to collateral resets (e.g. `git checkout -- .`
# reverting a file that's dual-tracked in the public repo), in which case we
# cannot tell an intentional delete from collateral damage and must never
# remove (push-core-data's core files are dual-tracked this way; that's why
# it never deletes). Only pass --allow-delete for a SRC_DIR that is entirely
# gitignored in the public repo (no dual-tracking, so "missing" always means
# "this run removed it") AND has real callers that rely on deletions
# propagating — e.g. data/aggregator-archive/'s quarantine-by-rename pattern
# (scripts/lib/lbo-roundup-discover.js renames a bad archive file to
# `.mismatch` on validation failure; without delete propagation the stale
# file would never leave the private repo and would keep resurrecting on
# every checkout, silently defeating the quarantine).
#
# Usage: sync-changed-files.sh [--allow-delete] SRC_DIR SNAPSHOT_DIR DEST_DIR
# Prints "COPIED=<n> SKIPPED=<n> DELETED=<n>" on the last line of stdout.
set -euo pipefail

ALLOW_DELETE=0
if [ "${1:-}" = "--allow-delete" ]; then
  ALLOW_DELETE=1
  shift
fi

SRC_DIR="$1"
SNAPSHOT_DIR="$2"
DEST_DIR="$3"

mkdir -p "$DEST_DIR"

COPIED=0
SKIPPED=0
DELETED=0

if [ -d "$SRC_DIR" ]; then
  while IFS= read -r -d '' f; do
    relpath="${f#./}"
    working="$SRC_DIR/$relpath"
    snapshot="$SNAPSHOT_DIR/$relpath"
    dest="$DEST_DIR/$relpath"
    if [ ! -f "$snapshot" ] || ! cmp -s "$working" "$snapshot"; then
      mkdir -p "$(dirname "$dest")"
      cp -f "$working" "$dest"
      COPIED=$((COPIED + 1))
    else
      SKIPPED=$((SKIPPED + 1))
    fi
  done < <(cd "$SRC_DIR" && find . -type f -print0)
fi

if [ "$ALLOW_DELETE" = "1" ] && [ -d "$SNAPSHOT_DIR" ]; then
  while IFS= read -r -d '' f; do
    relpath="${f#./}"
    working="$SRC_DIR/$relpath"
    dest="$DEST_DIR/$relpath"
    if [ ! -f "$working" ] && [ -f "$dest" ]; then
      rm -f "$dest"
      DELETED=$((DELETED + 1))
    fi
  done < <(cd "$SNAPSHOT_DIR" && find . -type f -print0)
fi

echo "COPIED=$COPIED SKIPPED=$SKIPPED DELETED=$DELETED"
