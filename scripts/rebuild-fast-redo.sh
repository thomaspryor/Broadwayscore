#!/usr/bin/env bash
# rebuild-fast-redo.sh — redo rebuild-fast.yml's fast rebuild on a fresh
# origin/main after its push lost every retry race (BRO-2783). Invoked by
# scripts/lib/rebuild-fast-push-cycle.sh AFTER it has `git reset --hard` onto
# the fresh remote tip, so every tracked file here starts from main's version.
#
# Redoes only the side-effect-free, local steps that produce what the commit
# stages:
#   rebuild-all-reviews.js -> generate-mobile-artifacts.sh -> BRO-3127 staleness
#   revert -> audit-score-public-since.js
# then carries this run's orphan-unscored broadcast-gate markers over from the
# lost commit (verify-all-scored.js is NOT re-run: it dispatches scoring and
# sends alerts), and restages + commits via rebuild-fast-stage-commit.sh.
# Deliberately NOT re-run: the review-texts flagger/sweeps (their output was
# already pushed to the private repo), the completeness alert, the awaiting-
# score sweep — all have external side effects or write nothing here.
#
# Env:
#   REBUILD_FAST_SAFE_TO_PUBLISH  must be 'true' (staleness guard verdict), else refuse
#   REBUILD_FAST_LOST_COMMIT  commit that failed to land (set by the cycle loop)
#   REBUILD_FORCE_WRITE       'true' to pass --force-write to rebuild-all-reviews.js
#   REBUILD_FAST_REGEN_CMD    override the regenerate chain (tests only)
#   REVIEWS_BEFORE, REBUILD_REASON  passed through to the commit message
# Exit: 0 committed, 3 nothing to commit, other = failure (do not push).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git rev-parse --show-toplevel)"

# Fail closed: regenerating public data is only safe when the first pass's
# staleness guard (check-rebuild-staleness.js) cleared this run to publish.
if [ "${REBUILD_FAST_SAFE_TO_PUBLISH:-}" != "true" ]; then
  echo "::error::rebuild-fast redo refused: staleness guard did not mark this run safe_to_publish (got '${REBUILD_FAST_SAFE_TO_PUBLISH:-}')"
  exit 1
fi

if [ -n "${REBUILD_FAST_REGEN_CMD:-}" ]; then
  eval "$REBUILD_FAST_REGEN_CMD"
else
  FORCE_FLAG=()
  [ "${REBUILD_FORCE_WRITE:-false}" = "true" ] && FORCE_FLAG=(--force-write)
  node "$SCRIPT_DIR/rebuild-all-reviews.js" "${FORCE_FLAG[@]}"
  bash "$SCRIPT_DIR/generate-mobile-artifacts.sh"
  bash "$SCRIPT_DIR/lib/revert-staleness-flagged-shows.sh"
  node "$SCRIPT_DIR/audit-score-public-since.js" || echo "::warning::audit-score-public-since.js failed during redo (fail-open, same as the first pass)"
fi

# Carry this run's orphan-unscored markers (adds, updates AND deletions) from
# the lost commit. They are per-show snapshots that only verify-all-scored.js
# writes, so this run's fresh verdict is the right one to keep.
LOST="${REBUILD_FAST_LOST_COMMIT:-}"
if [ -n "$LOST" ] && git cat-file -e "$LOST^{commit}" 2>/dev/null \
   && git cat-file -e "$LOST^^{commit}" 2>/dev/null; then
  while IFS=$'\t' read -r status path; do
    [ -z "${path:-}" ] && continue
    case "$status" in
      D) git rm -q --ignore-unmatch -- "$path" ;;
      *) git checkout "$LOST" -- "$path" ;;
    esac
  done < <(git diff --no-renames --name-status "$LOST^" "$LOST" -- 'data/audit/orphan-unscored-*.json')
elif [ -n "$LOST" ]; then
  echo "::warning::rebuild-fast redo: cannot read lost commit $LOST or its parent; orphan-unscored markers not carried (next run rewrites them)"
fi

# The redo rebuilt reviews.json, so recount rather than reuse the first pass's.
if [ -f data/reviews.json ]; then
  REVIEWS_AFTER="$(node -e "console.log(require('./data/reviews.json').reviews.length)" 2>/dev/null || echo "${REVIEWS_AFTER:-0}")"
fi
export REVIEWS_AFTER

exec bash "$SCRIPT_DIR/rebuild-fast-stage-commit.sh"
