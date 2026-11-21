#!/usr/bin/env bash
# revert-staleness-flagged-shows.sh — BRO-3127 reconciliation, extracted from
# rebuild-fast.yml (BRO-2783) so the post-lost-race redo reuses it verbatim.
#
# check-rebuild-staleness.js writes the show ids it flagged as missing to
# $RUNNER_TEMP/staleness-missing-shows.txt. generate-mobile-show-details.js
# regenerates EVERY show, including those flagged ones, from a possibly
# incomplete reviews.json. Revert just those per-show files to HEAD so the
# flagged show keeps last-known-good public data; remove a brand-new show's
# file (no HEAD version to revert to). Aggregates are intentionally untouched.
#
# Usage: bash scripts/lib/revert-staleness-flagged-shows.sh [missing-shows-file]
set -uo pipefail

FILE="${1:-${RUNNER_TEMP:-/tmp}/staleness-missing-shows.txt}"
[ -s "$FILE" ] || exit 0

echo "Staleness guard flagged show(s) — reconciling their public/data/shows/*.json (BRO-3127):"
while IFS= read -r show_id; do
  [ -z "$show_id" ] && continue
  TARGET="public/data/shows/$show_id.json"
  if git cat-file -e "HEAD:$TARGET" 2>/dev/null; then
    git checkout HEAD -- "$TARGET" 2>/dev/null \
      && echo "  reverted to last-known-good: $show_id" \
      || echo "::warning::could not revert $TARGET for flagged show $show_id"
  elif [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    echo "  removed (newly-generated, no prior committed version to revert to): $show_id"
  else
    echo "  skip (no public JSON exists at all): $show_id"
  fi
done < "$FILE"
exit 0
