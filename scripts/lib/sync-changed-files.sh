#!/usr/bin/env bash
# Copies only the files under SRC_DIR that differ from their counterpart in
# SNAPSHOT_DIR (byte comparison via cmp) into DEST_DIR. A file identical to
# its snapshot is skipped — it was never touched by whatever wrote SRC_DIR
# this run, so copying it back would push stale content and revert any
# concurrent writer's changes to that same file (P0 2026-07-13 push-core-data
# incident; scripts/lib/core-data-sync-decision.js pins the same per-file
# decision table for the fixed-file-list variant of this problem).
#
# No deletion path: a file present in DEST_DIR but absent from SRC_DIR is
# left untouched. We cannot tell an intentional local delete from collateral
# damage (e.g. `git checkout -- .` reverting a file), so the safe default is
# to never remove.
#
# Usage: sync-changed-files.sh SRC_DIR SNAPSHOT_DIR DEST_DIR
# Prints "COPIED=<n> SKIPPED=<n>" on the last line of stdout.
set -euo pipefail

SRC_DIR="$1"
SNAPSHOT_DIR="$2"
DEST_DIR="$3"

mkdir -p "$DEST_DIR"

COPIED=0
SKIPPED=0

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

echo "COPIED=$COPIED SKIPPED=$SKIPPED"
