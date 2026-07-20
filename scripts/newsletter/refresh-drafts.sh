#!/usr/bin/env bash
# refresh-drafts.sh — LOCAL fast lane for updating the weekly Resend drafts.
#
# The CI path (newsletter-draft.yml) costs ~10-25 min per iteration: runner
# spin-up, checkout, Playwright install, serial concurrency queue across the
# two editions. All the underlying scripts run fine locally against the local
# core-data checkout, and create-broadcast-draft.mjs PATCHes the existing
# same-name Resend draft in place — so a data-only refresh (scores moved,
# a pull quote changed) takes ~2 min locally. Born 2026-07-19: three CI
# regen round-trips on send day, each ~25 min wall-clock.
#
# What it does, per edition (broadway, west-end):
#   1. git pull the core-data + review-texts checkouts (staleness guard:
#      create-broadcast-draft refuses if the data repo is behind origin)
#   2. generate.mjs           — build HTML + meta for the week
#   3. pre-send-check.mjs     — hard/soft invariants (unsubscribe, UTMs, subject)
#   4. overflow-check.mjs     — 375px render gate (needs local Playwright)
#   5. create-broadcast-draft.mjs --create — PATCH the existing Resend DRAFT
#      (never sends; owner still clicks Send in the Resend UI)
#
# It does NOT rebuild reviews.json — that must come from CI (rebuild-reviews /
# rebuild-fast); never run rebuild-all-reviews.js locally (stale-clone hazard,
# memory/feedback_local_rebuild_stale_clone_hazard.md).
#
# Usage:
#   bash scripts/newsletter/refresh-drafts.sh [weekStart YYYY-MM-DD]
#     weekStart defaults to the most recent Monday in America/New_York.
#   Requires .env with RESEND_API_KEY (+ GA4_PROPERTY_ID/GA_KEY_FILE for the
#   Trending section — without them that section silently no-ops).

set -euo pipefail
cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  echo "ERROR: no .env here ($(pwd)) — run from the main configured checkout (needs RESEND_API_KEY), not a worktree/fresh clone." >&2
  exit 1
fi
set -a; source .env; set +a

WEEK="${1:-$(TZ=America/New_York date -v-mon +%Y-%m-%d 2>/dev/null || TZ=America/New_York date -d 'last monday' +%Y-%m-%d)}"
OUT="${NEWSLETTER_OUT_DIR:-$HOME/Documents/claude-outputs/newsletter-mocks}"
mkdir -p "$OUT"

echo "== Refreshing drafts for week $WEEK (out: $OUT)"

echo "== Pulling data repos"
# realpath handles both the symlinked layout (data/reviews.json -> core-data
# clone) and a pre-setup regular file, unlike bare readlink.
DATA_REPO=$(node -e "console.log(require('path').dirname(require('fs').realpathSync('data/reviews.json')))")
git -C "$DATA_REPO" pull --rebase --quiet
git -C data/review-texts pull --rebase --quiet 2>/dev/null || true
# The per-show cs/rc JSONs (public/data/shows/) that generate.mjs reads live in
# THIS repo and are committed by CI rebuilds — a fresh reviews.json alone is not
# enough. Skipping this pull shipped a stale review count (24 vs 23, 2026-07-19),
# and create-broadcast-draft's staleness guard only covers the core-data repo —
# nothing downstream catches stale per-show files. So a failed pull is a hard
# abort, not a warning.
echo "== Pulling main repo (per-show score JSONs)"
if ! git pull --rebase --autostash --quiet; then
  echo "ERROR: main repo pull failed — public/data/shows would be stale (24-vs-23 incident class). Resolve and re-run." >&2
  exit 1
fi

for EDITION in broadway west-end; do
  AUDIENCE=general
  [ "$EDITION" = "west-end" ] && AUDIENCE=west-end
  echo ""
  echo "== [$EDITION] generate"
  NEWSLETTER_EDITION=$EDITION NEWSLETTER_OUT_DIR="$OUT" node scripts/newsletter/generate.mjs "$WEEK"
  echo "== [$EDITION] pre-send check"
  NEWSLETTER_EDITION=$EDITION NEWSLETTER_OUT_DIR="$OUT" node scripts/newsletter/pre-send-check.mjs "$WEEK"
  echo "== [$EDITION] mobile overflow gate"
  NEWSLETTER_EDITION=$EDITION NEWSLETTER_OUT_DIR="$OUT" node scripts/newsletter/overflow-check.mjs "$WEEK"
  echo "== [$EDITION] PATCH Resend draft (never sends)"
  NEWSLETTER_EDITION=$EDITION node scripts/newsletter/create-broadcast-draft.mjs "$WEEK" --create --audience=$AUDIENCE --out-dir="$OUT"
  # generate.mjs appends to the tracked data/newsletter-state.json on every run.
  # CI commits that (dedup state); this local wrapper must not leave it dirty —
  # a dirty copy autostash-conflicts with CI's upstream version on the next
  # pull above, and conflict markers then break generate's state read.
  # NOTE: unlike CI, this wrapper also skips regression-test.mjs (non-blocking
  # in CI) and the [DRAFT] owner-preview email — the owner is already reviewing
  # the draft in the Resend UI in this flow.
  git checkout -- data/newsletter-state.json 2>/dev/null || true
done

echo ""
echo "== Done. Both drafts updated in place — review + Send in the Resend UI."
