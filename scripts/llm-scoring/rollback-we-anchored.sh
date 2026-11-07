#!/bin/bash
# Rollback the West End anchored-bands rescore by restoring per-file JSONs
# from the pre-rescore tag. Belt-and-suspenders to the canonical tag-based
# rollback path. Designed to be run from any working directory.
#
# Usage:
#   bash rollback-we-anchored.sh --dry-run                                          # default tag
#   bash rollback-we-anchored.sh                                                    # actually restore
#   bash rollback-we-anchored.sh --tag=before-anchored-bands-WE-2026-05-20 --dry-run  # override tag

set -euo pipefail

# Tag can be overridden via --tag=NAME. Default is the W0-T2 tag created on
# 2026-05-16; override when W0 ran on a different date or for a different
# rollback target. Ship-check P1-5: tag is no longer hardcoded.
DEFAULT_TAG="before-anchored-bands-WE-2026-05-16"
SHOW_LIST="$HOME/Documents/claude-outputs/anchored-bands/we-show-ids.txt"
REVIEW_TEXTS_REPO="$HOME/broadway-review-texts"
SCORECARD_DATA_REPO="$HOME/broadway-scorecard-data"

DRY_RUN=false
TAG="$DEFAULT_TAG"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true; echo "[dry-run] no files will be modified" ;;
    --tag=*)   TAG="${arg#--tag=}" ;;
    --help|-h) echo "Usage: $0 [--dry-run] [--tag=before-anchored-bands-WE-YYYY-MM-DD]"; exit 0 ;;
  esac
done
echo "[rollback] using tag: $TAG"

if [ ! -f "$SHOW_LIST" ]; then
  echo "ERROR: $SHOW_LIST missing (run W0-T4 first)"
  exit 1
fi

if [ ! -d "$REVIEW_TEXTS_REPO/.git" ]; then
  echo "ERROR: $REVIEW_TEXTS_REPO is not a git repo"
  exit 1
fi

cd "$REVIEW_TEXTS_REPO"
if ! git rev-parse --verify "$TAG" > /dev/null 2>&1; then
  echo "ERROR: tag $TAG not found in $REVIEW_TEXTS_REPO"
  exit 1
fi

echo "=== Rolling back ${REVIEW_TEXTS_REPO} for $(wc -l < "$SHOW_LIST" | tr -d ' ') WE/OWE shows ==="
COUNT=0
while IFS= read -r SHOW_ID; do
  [ -z "$SHOW_ID" ] && continue
  if [ -d "$REVIEW_TEXTS_REPO/$SHOW_ID" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "  would restore: $SHOW_ID"
    else
      git -C "$REVIEW_TEXTS_REPO" checkout "$TAG" -- "$SHOW_ID/" 2>&1 | sed "s/^/  ${SHOW_ID}: /" || true
    fi
    COUNT=$((COUNT + 1))
  fi
done < "$SHOW_LIST"
echo "  $([ "$DRY_RUN" = true ] && echo "would touch" || echo "touched") $COUNT show directories"

if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "=== Next steps ==="
  echo "1. Review changes: git -C $REVIEW_TEXTS_REPO status"
  echo "2. If happy, commit: git -C $REVIEW_TEXTS_REPO commit -am 'rollback: revert WE anchored-bands rescore'"
  echo "3. Push: git -C $REVIEW_TEXTS_REPO push origin main"
  echo "4. Also restore reviews.json: git -C $SCORECARD_DATA_REPO checkout $TAG -- reviews.json && commit + push"
  echo "5. Force fresh Vercel deploy: gh workflow run 'Deploy to Vercel'"
fi
