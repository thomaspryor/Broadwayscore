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
#   4. commercial-json: data/commercial.json must go through the lock+merge
#      guard in scripts/lib/commercial-write-guard.js — same class of bug as
#      shows.json, 31 unlocked writers (card: generalize shows-write-guard.js)
#      — unless the script is on .commercial-json-write-exempt.txt.
#   5. audience-buzz-json: data/audience-buzz.json must go through the
#      lock+merge guard in scripts/lib/audience-buzz-write-guard.js — same
#      class of bug, 33 unlocked writers — unless the script is on
#      .audience-buzz-json-write-exempt.txt.
#
# Called from BOTH:
#   - CI: .github/workflows/test.yml (Lint Workflows job)
#   - local: scripts/hooks/pre-push (when the push touches scripts/*.js)
# so a violation blocks at push time instead of reddening main for hours
# (2026-07-12: 24 consecutive Test Suite failures from one unlinted script).
#
# Usage: lint-write-routing.sh [review-texts|reviews-json|shows-json|commercial-json|audience-buzz-json|all]   (default: all)

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

MODE="${1:-all}"
FAILED=0

read_allowlist() {
  # Extract filenames from an allowlist file (strip comments + " -- reason").
  grep -v '^[[:space:]]*#' "$1" | grep -v '^[[:space:]]*$' | awk -F' --' '{print $1}' | tr -d ' '
}

# ── allowlist membership, done in-process ──────────────────────────────────
#
# Every check below used to test membership with
#   echo "$EXEMPT" | grep -Fxq "$name" && continue
# once per candidate file. Two forks per file per check — ~600 files x 5
# checks = ~6,000 subprocesses per `all` run — and, critically, a lookup whose
# FAILURE IS INDISTINGUISHABLE FROM "not in the list". `set -o pipefail` is on
# (line 33), so any non-zero from either stage of that pipeline — a grep killed
# by the runner, a fork that didn't take under memory pressure, a short write —
# reads as "not exempt". The file is then reported as a write-routing
# violation with an empty stderr and nothing anywhere saying the lookup itself
# broke.
#
# That is the exact shape of the 2026-08-14 CI flake. Three consecutive runs of
# scripts/notion-action-poll.test.mjs's `lint-write-routing.sh review-texts
# exits 0` gate on main:
#   run 31829014708  ok 703      (11,974 ms)
#   run 31832656296  ok 703      ( 8,698 ms)
#   run 31834465040  not ok 703  (12,801 ms) — named recover-login-page-reviews.js
# `git diff 7caf9ce03bb 8969026ac24 -- scripts/recover-login-page-reviews.js
# .review-write-guard-exempt.txt scripts/lint-write-routing.sh` is EMPTY, and
# that file sits on line 105 of the allowlist at all three shas. It is also one
# of 106 files the review-texts allowlist covers, and exactly one of them was
# reported — so the allowlist was not mis-parsed wholesale; a single
# per-file lookup returned the wrong answer. A local probe of that pipeline
# (20,000 iterations, macOS/bash 5.3) reproduced 0 anomalies, which is why the
# fix is to remove the failure surface rather than to chase the syscall: a
# membership test against a fixed in-memory string forks nothing and therefore
# has nothing left to fail transiently.
#
# Bash 3.2-compatible on purpose (no associative arrays): the shebang is
# /usr/bin/env bash and this script is also invoked by scripts/hooks/pre-push
# on macOS, where /bin/bash is still 3.2.
#
# $1 is the allowlist newline-SENTINEL form (leading and trailing newline) so
# a substring test is an exact whole-line match; $2 is the basename.
exempt_has() {
  [[ "$1" == *$'\n'"$2"$'\n'* ]]
}

# An allowlist that HAS entry lines but parses to ZERO entries means the parser
# broke, not that nothing is exempt — and silently proceeding would flag every
# allowlisted file at once (106 of them for review-texts). Fail loudly and
# specifically instead, so that failure can never again be mistaken for a
# genuine write-routing violation.
#
# The discriminator is entry LINES, not file size: .shows-json-write-exempt.txt
# and .audience-buzz-json-write-exempt.txt are fully migrated and now contain
# nothing but comments, which is a legitimate empty allowlist and must stay
# green (a `[ -s "$file" ]` test reddened both of them).
allowlist_parse_ok() {
  local file="$1" parsed="$2" entry_lines
  entry_lines=$(grep -cvE '^[[:space:]]*(#|$)' "$file")
  if [ "${entry_lines:-0}" -gt 0 ] && [ -z "$parsed" ]; then
    echo "::error::$file has $entry_lines entry line(s) but parsed to zero allowlist entries — the allowlist PARSER is broken; this is not a write-routing violation"
    return 1
  fi
  return 0
}

check_review_texts() {
  local ALLOWLIST=".review-write-guard-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT EXEMPT_NL VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  allowlist_parse_ok "$ALLOWLIST" "$EXEMPT" || { FAILED=1; return; }
  EXEMPT_NL=$'\n'"$EXEMPT"$'\n'
  for f in scripts/*.js; do
    name=$(basename "$f")
    # Guard itself is exempt
    [ "$name" = "review-write-guard.js" ] && continue
    exempt_has "$EXEMPT_NL" "$name" && continue
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
  local EXEMPT EXEMPT_NL VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  allowlist_parse_ok "$ALLOWLIST" "$EXEMPT" || { FAILED=1; return; }
  EXEMPT_NL=$'\n'"$EXEMPT"$'\n'
  for f in scripts/*.js; do
    name=$(basename "$f")
    exempt_has "$EXEMPT_NL" "$name" && continue
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
  local EXEMPT EXEMPT_NL VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  allowlist_parse_ok "$ALLOWLIST" "$EXEMPT" || { FAILED=1; return; }
  EXEMPT_NL=$'\n'"$EXEMPT"$'\n'
  # .js is the dominant top-level script extension in this repo, but .mjs
  # and .ts top-level scripts exist too (scripts/lib/*.ts, scripts/*.mjs are
  # test/library files excluded by staying at depth 1) and were found
  # capable of the same bypass class in review — cover them too.
  for f in scripts/*.js scripts/*.mjs scripts/*.ts; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    exempt_has "$EXEMPT_NL" "$name" && continue
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

check_commercial_json() {
  local ALLOWLIST=".commercial-json-write-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT EXEMPT_NL VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  allowlist_parse_ok "$ALLOWLIST" "$EXEMPT" || { FAILED=1; return; }
  EXEMPT_NL=$'\n'"$EXEMPT"$'\n'
  for f in scripts/*.js scripts/*.mjs scripts/*.ts; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    exempt_has "$EXEMPT_NL" "$name" && continue
    # Same shape of check as shows-json: (1) references data/commercial.json
    # AND (2) writeFileSync to a var whose name IS "commercial" + path/file/
    # json, word-bounded, case-insensitive, or a literal commercial.json path,
    # AND (3) does NOT route through commercial-write-guard.
    if grep -qE "['\"][^'\"]*data/commercial\.json['\"]|path\.join\([^)]*['\"]commercial\.json['\"]" "$f" \
      && grep -qEi "fs\.writeFileSync\([^)]*\bcommercial[_a-z]*(path|file|json)\b|fs\.writeFileSync\([^)]*['\"][^'\"]*data/commercial\.json['\"]" "$f" \
      && ! grep -q "commercial-write-guard" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scripts write data/commercial.json without the commercial-write-guard lock+merge:"
    for v in $VIOLATIONS; do echo "  $v"; done
    echo "Fix: const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard'); use those in place of"
    echo "your own fs.readFileSync/writeFileSync(COMMERCIAL_PATH, ...) pair."
    echo "If this script genuinely can't (e.g. it targets a different commercial.json-shaped file), add it to"
    echo "$ALLOWLIST with a one-line reason."
    FAILED=1
  else
    echo "All detected commercial.json writes route through commercial-write-guard"
  fi
}

check_audience_buzz_json() {
  local ALLOWLIST=".audience-buzz-json-write-exempt.txt"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "::error::missing allowlist file: $ALLOWLIST"
    FAILED=1
    return
  fi
  local EXEMPT EXEMPT_NL VIOLATIONS="" f name
  EXEMPT=$(read_allowlist "$ALLOWLIST")
  allowlist_parse_ok "$ALLOWLIST" "$EXEMPT" || { FAILED=1; return; }
  EXEMPT_NL=$'\n'"$EXEMPT"$'\n'
  for f in scripts/*.js scripts/*.mjs scripts/*.ts; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    exempt_has "$EXEMPT_NL" "$name" && continue
    if grep -qE "['\"][^'\"]*data/audience-buzz\.json['\"]|path\.join\([^)]*['\"]audience-buzz\.json['\"]" "$f" \
      && grep -qEi "fs\.writeFileSync\([^)]*\baudience[-_a-z]*buzz[_a-z]*(path|file|json)\b|fs\.writeFileSync\([^)]*['\"][^'\"]*data/audience-buzz\.json['\"]" "$f" \
      && ! grep -q "audience-buzz-write-guard" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scripts write data/audience-buzz.json without the audience-buzz-write-guard lock+merge:"
    for v in $VIOLATIONS; do echo "  $v"; done
    echo "Fix: const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard'); use those in place of"
    echo "your own fs.readFileSync/writeFileSync(AUDIENCE_BUZZ_PATH, ...) pair."
    echo "If this script genuinely can't (e.g. it targets a different audience-buzz.json-shaped file), add it to"
    echo "$ALLOWLIST with a one-line reason."
    FAILED=1
  else
    echo "All detected audience-buzz.json writes route through audience-buzz-write-guard"
  fi
}

case "$MODE" in
  review-texts) check_review_texts ;;
  reviews-json) check_reviews_json ;;
  shows-json) check_shows_json ;;
  commercial-json) check_commercial_json ;;
  audience-buzz-json) check_audience_buzz_json ;;
  all) check_review_texts; check_reviews_json; check_shows_json; check_commercial_json; check_audience_buzz_json ;;
  *) echo "usage: $0 [review-texts|reviews-json|shows-json|commercial-json|audience-buzz-json|all]" >&2; exit 2 ;;
esac

exit "$FAILED"
