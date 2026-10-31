#!/usr/bin/env bash
# rebuild-fast-redo.sh — redo rebuild-fast.yml's fast rebuild on a fresh
# origin/main after its push lost every retry race (BRO-2783). Invoked by
# scripts/lib/rebuild-fast-push-cycle.sh AFTER it has `git reset --hard` onto
# the fresh remote tip, so every tracked file here starts from main's version.
#
# Redoes only the side-effect-free, local steps that produce what the commit
# stages:
#   rebuild-all-reviews.js -> generate-mobile-artifacts.sh -> generate-onboarding-data.ts -> BRO-3127 staleness
#   revert -> audit-score-public-since.js
# then:
#   * data/audit/: discards whatever the regen wrote there and REPLAYS the lost
#     commit's data/audit diff onto fresh main (scripts/lib/rebuild-fast-replay-
#     audit.js: 3-way `git apply -3`, registry mergers for the alert ledger /
#     digest queue on conflict, else keep main's copy). This keeps the first
#     pass's ledger rows, digest lines, state snapshots and orphan-unscored
#     markers (verify-all-scored.js and the alert router are NOT re-run: they
#     dispatch scoring and send alerts) without overwriting other writers'.
#   * staging is LIMITED to the paths the lost commit changed
#     (REBUILD_FAST_STAGE_ONLY_PATHS_FILE, read by rebuild-fast-stage-commit.sh).
#     The regen rewrites EVERY show from this job's inputs; a show another
#     writer updated on fresh main (newer reviews) that this run did not change
#     must keep main's version, exactly as the old `rebase -X theirs` only
#     overrode files in our own diff.
#   then restages + commits via rebuild-fast-stage-commit.sh.
# Deliberately NOT re-run: the review-texts flagger/sweeps (their output was
# already pushed to the private repo), the completeness alert, the awaiting-
# score sweep — all have external side effects or write nothing here.
#
# Env:
#   REBUILD_FAST_SAFE_TO_PUBLISH  must be 'true' (staleness guard verdict), else refuse
#   REBUILD_FAST_LOST_COMMIT  commit that failed to land (set by the cycle loop);
#                             required, the redo refuses without it
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

# Fail closed: without the lost commit (and its parent) we can neither replay
# its data/audit writes nor scope staging to its paths, and staging the whole
# regenerated tree would revert other writers' newer show files.
LOST="${REBUILD_FAST_LOST_COMMIT:-}"
if [ -z "$LOST" ] || ! git cat-file -e "$LOST^{commit}" 2>/dev/null \
   || ! git cat-file -e "$LOST^^{commit}" 2>/dev/null; then
  echo "::error::rebuild-fast redo refused: cannot read lost commit '${LOST}' or its parent (needed to replay data/audit and scope staging)"
  exit 1
fi
# A merge commit is never this run's own rebuild commit (stage-commit makes a
# single-parent commit): LOST^..LOST would be another writer's diff, so the
# replay and the staging scope would publish THEIR paths and drop ours.
LOST_PARENTS="$(git rev-list --parents -n1 "$LOST" | wc -w)"
if [ "$LOST_PARENTS" -gt 2 ]; then
  echo "::error::rebuild-fast redo refused: lost commit $LOST is a merge commit ($((LOST_PARENTS - 1)) parents); its first-parent diff is not this run's rebuild"
  exit 1
fi

if [ -n "${REBUILD_FAST_REGEN_CMD:-}" ]; then
  eval "$REBUILD_FAST_REGEN_CMD"
else
  FORCE_FLAG=()
  [ "${REBUILD_FORCE_WRITE:-false}" = "true" ] && FORCE_FLAG=(--force-write)
  node "$SCRIPT_DIR/rebuild-all-reviews.js" ${FORCE_FLAG[@]+"${FORCE_FLAG[@]}"}
  bash "$SCRIPT_DIR/generate-mobile-artifacts.sh"
  # BRO-6647: onboarding data, fail-open like the first pass (a bad check keeps main's copy).
  if ! { npx tsx "$SCRIPT_DIR/generate-onboarding-data.ts" && node "$SCRIPT_DIR/test-onboarding-data.js"; }; then
    echo "::warning::onboarding data generation/check failed during redo (fail-open)"
    git checkout -- public/data/onboarding-cities.json public/data/onboarding-hits.json 2>/dev/null || true
  fi
  bash "$SCRIPT_DIR/lib/revert-staleness-flagged-shows.sh"
  node "$SCRIPT_DIR/audit-score-public-since.js" || echo "::warning::audit-score-public-since.js failed during redo (fail-open, same as the first pass)"
fi

# data/audit: start from fresh main's copy, then replay the lost commit's diff.
if git cat-file -e "HEAD:data/audit" 2>/dev/null; then
  git checkout -q HEAD -- data/audit
fi
git clean -fdq -- data/audit
node "$SCRIPT_DIR/lib/rebuild-fast-replay-audit.js" "$LOST"

# Scope staging to the lost commit's own paths.
STAGE_ONLY="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rebuild-fast-stage-only.XXXXXX")"
trap 'rm -f "$STAGE_ONLY"' EXIT
# NUL-delimited (-z): quoted/escaped paths (core.quotepath) cannot mismatch.
git diff --no-renames --name-only -z "$LOST^" "$LOST" > "$STAGE_ONLY"
export REBUILD_FAST_STAGE_ONLY_PATHS_FILE="$STAGE_ONLY"

# The redo rebuilt reviews.json, so recount rather than reuse the first pass's.
if [ -f data/reviews.json ]; then
  REVIEWS_AFTER="$(node -e "console.log(require('./data/reviews.json').reviews.length)" 2>/dev/null || echo "${REVIEWS_AFTER:-}")"
fi
export REVIEWS_AFTER

rc=0
bash "$SCRIPT_DIR/rebuild-fast-stage-commit.sh" || rc=$?
exit "$rc"
