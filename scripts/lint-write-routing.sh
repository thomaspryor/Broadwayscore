#!/usr/bin/env bash
# Shared write-routing lint — single source of truth for the data-write
# gates that used to live inline in .github/workflows/test.yml:
#
#   1. review-texts: every write to data/review-texts/ MUST go through
#      safeWriteReview (Joe Turner postmortem P0 #2, 2026-04-26) unless the
#      script is on .review-write-guard-exempt.txt (topology movers).
#   2. reviews-json: data/reviews.json is derived — scripts must not write it
#      directly (bypasses the rebuild audit trail) unless on
#      .reviews-json-write-exempt.txt.
#   3. shows-json: data/shows.json must go through the lock+merge guard in
#      scripts/lib/shows-write-guard.js — 50+ unlocked writers used to race
#      each other and silently clobber concurrent edits (card: shows.json
#      concurrency lock) — unless the script is on
#      .shows-json-write-exempt.txt.
#
# Called from BOTH:
#   - CI: .github/workflows/test.yml (Lint Workflows job)
#   - local: scripts/hooks/pre-push (when the push touches scripts/*.js)
# so a violation blocks at push time instead of reddening main for hours
# (2026-07-12: 24 consecutive Test Suite failures from one unlinted script).
#
# Usage: lint-write-routing.sh [review-texts|reviews-json|shows-json|all]   (default: all)

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

MODE="${1:-all}"
FAILED=0

read_allowlist() {
  # Extract filenames from an allowlist file (strip comments + " -- reason").
  grep -v '^[[:space:]]*#' "$1" | grep -v '^[[:space:]]*$' | awk -F' --' '{print $1}' | tr -d ' '
}

check_review_texts() {
  local ALLOWLIST=".review-write-guard-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  for f in scripts/*.js; do
    name=$(basename "$f")
    # Guard itself is exempt
    [ "$name" = "review-write-guard.js" ] && continue
    echo "$EXEMPT" | grep -Fxq "$name" && continue
    # Match writeFileSync calls where the first argument resolves to a
    # review-texts path: common variable names, path.join(showDir-ish vars),
    # or path.join('data','review-texts',...) literals. A file counts as a
    # violator only if it ALSO references review-texts somewhere AND does
    # NOT import safeWriteReview.
    if grep -qE "fs\.writeFileSync\((\bfilePath\b|\bfullPath\b|\bfilepath\b|\bfp\b|\bfullpath\b|\bnewPath\b|\btargetPath\b|\boutPath\b|path\.join\((showDir|dirPath|REVIEW_TEXTS_DIR|REVIEW_TEXTS_BASE|reviewsDir|rtDir|REVIEW_TEXTS_ROOT)|path\.join\(['\"]data['\"], ['\"]review-texts['\"])" "$f" \
      && grep -qE "(review-texts|REVIEW_TEXTS_DIR|REVIEW_TEXTS_BASE|rtDir|reviewsDir|REVIEW_TEXTS_ROOT)" "$f" \
      && ! grep -q "safeWriteReview" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scripts write directly to review-texts/ without safeWriteReview:"
    for v in $VIOLATIONS; do echo "  $v"; done
    echo "Either:"
    echo "  (a) Import { safeWriteReview } from './lib/review-write-guard' and route the write through it."
    echo "  (b) For topology operations (move/delete/rename), add the file to .review-write-guard-exempt.txt with a one-line reason."
    FAILED=1
  else
    echo "All detected review-texts writes route through safeWriteReview"
  fi
}

check_reviews_json() {
  local ALLOWLIST=".reviews-json-write-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  for f in scripts/*.js; do
    name=$(basename "$f")
    echo "$EXEMPT" | grep -Fxq "$name" && continue
    # (1) references data/reviews.json AND (2) writeFileSync to a known
    # reviews-path constant or literal. outPath deliberately excluded (audit
    # scripts use it for report files).
    if grep -qE "['\"][^'\"]*data/reviews\.json['\"]|path\.join\([^)]*['\"]data['\"][^)]*['\"]reviews\.json['\"]" "$f" \
      && grep -qE "fs\.writeFileSync\([^)]*(REVIEWS_PATH|reviewsTmpPath|reviewsJsonPath|reviewsPath|targetPath|['\"][^'\"]*data/reviews\.json['\"])" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scripts write data/reviews.json directly (bypasses rebuild audit trail):"
    for v in $VIOLATIONS; do echo "  $v"; done
    echo "Fix: modify the source files in data/review-texts/<showId>/ instead, then trigger 'Rebuild Reviews Data'."
    echo "If this script genuinely must write reviews.json (e.g., it IS the rebuild), add it to .reviews-json-write-exempt.txt with a one-line reason."
    FAILED=1
  else
    echo "All detected reviews.json writes route through rebuild-all-reviews"
  fi
}

check_shows_json() {
  local ALLOWLIST=".shows-json-write-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  for f in scripts/*.js; do
    name=$(basename "$f")
    echo "$EXEMPT" | grep -Fxq "$name" && continue
    # (1) references data/shows.json AND (2) writeFileSync to a var whose
    # name IS "shows" + path/file/json, word-bounded (case-insensitive —
    # catches SHOWS_PATH, showsFile, SHOWS_JSON_PATH, etc. without needing
    # every variant enumerated; a literal 'showsFile' miss slipped through
    # the old fixed-name list once already). The \b is required — without
    # it this also matches unrelated compound identifiers that merely
    # contain "shows", like diaryShowsPath/analystShowsPath (real vars in
    # scripts that write a DIFFERENT file and only read shows.json for
    # dedup lookups — a false-positive that would block legitimate pushes).
    # Also matches a literal shows.json path, AND (3) does NOT route
    # through shows-write-guard (loadShows/saveShows) or atomic-shows-
    # write.js directly (atomic-shows-write callers still need the
    # lock+merge layer, so they're violators too unless they also require
    # shows-write-guard).
    if grep -qE "['\"][^'\"]*data/shows\.json['\"]|path\.join\([^)]*['\"]shows\.json['\"]" "$f" \
      && grep -qEi "fs\.writeFileSync\([^)]*\bshows[_a-z]*(path|file|json)\b|fs\.writeFileSync\([^)]*['\"][^'\"]*data/shows\.json['\"]|atomicWriteShowsJson\(" "$f" \
      && ! grep -q "shows-write-guard" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scripts write data/shows.json without the shows-write-guard lock+merge:"
    for v in $VIOLATIONS; do echo "  $v"; done
    echo "Fix: const { loadShows, saveShows } = require('./lib/shows-write-guard'); use those in place of"
    echo "your own fs.readFileSync/writeFileSync(SHOWS_PATH, ...) pair (or atomicWriteShowsJson call)."
    echo "If this script genuinely can't (e.g. it targets a different shows.json-shaped file), add it to"
    echo "$ALLOWLIST with a one-line reason."
    FAILED=1
  else
    echo "All detected shows.json writes route through shows-write-guard"
  fi
}

case "$MODE" in
  review-texts) check_review_texts ;;
  reviews-json) check_reviews_json ;;
  shows-json) check_shows_json ;;
  all) check_review_texts; check_reviews_json; check_shows_json ;;
  *) echo "usage: $0 [review-texts|reviews-json|shows-json|all]" >&2; exit 2 ;;
esac

exit "$FAILED"
