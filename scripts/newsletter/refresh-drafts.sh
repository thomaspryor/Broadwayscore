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
#   Requires .env with RESEND_API_KEY (+ GA4_PROPERTY_ID and either
#   GA_KEY_FILE or GA_SERVICE_ACCOUNT_KEY for the Trending section). Those
#   GA4 vars are GitHub secrets, not in local .env — without them pre-send-
#   check.mjs's HARD no-access gate (card #1158) REFUSES to PATCH the Resend
#   draft rather than silently shipping it with Trending deleted. Run
#   newsletter-draft-refresh.yml (which holds the secrets) instead, or set
#   NEWSLETTER_ALLOW_NO_ACCESS=1 to send without Trending on purpose.

set -euo pipefail
cd "$(dirname "$0")/../.."

# A mid-loop failure (e.g. Resend 429 after the broadway PATCH) leaves one
# edition refreshed and the other stale. Re-running IS the reconciliation —
# every step is idempotent — so say that instead of failing silently.
trap 'git checkout -- data/newsletter-state.json 2>/dev/null || true; echo "FAILED partway — one edition may be refreshed and the other stale. Re-run this script to reconcile (all steps are idempotent)." >&2' ERR

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
# --autostash: local sessions and background jobs leave churn in the data
# clone; without it this pull hard-fails on any unstaged change.
git -C "$DATA_REPO" pull --rebase --autostash --quiet
git -C data/review-texts pull --rebase --quiet 2>/dev/null || true
# The per-show cs/rc JSONs (public/data/shows/) that generate.mjs reads live in
# THIS repo and are committed by CI rebuilds — a fresh reviews.json alone is not
# enough. Skipping this pull shipped a stale review count (24 vs 23, 2026-07-19),
# and create-broadcast-draft's staleness guard only covers the core-data repo —
# nothing downstream catches stale per-show files. So a failed pull is a hard
# abort, not a warning.
# Commit any local, uncommitted gap-audit stamps BEFORE pulling. The
# newsletter completeness gate's own remediation instructions
# (scripts/lib/newsletter-preflight.js) tell the operator to run
# `audit-show-review-gap.js --show=ID --checkpoint` and THEN re-run this
# script — that writes directly to the tracked
# data/audit/{show-review-gap,gap-audit-checkpoint,unknown-aggregator-outlets}.json
# files without committing. On send day the hourly gap-audit cron has
# usually ALSO committed to those same files in the interim, so the plain
# `git pull --rebase --autostash` below stashes the local stamps, rebases
# onto CI's newer commit, and then tries to reapply them — if that pop
# conflicts (near-guaranteed: both sides touch the same generatedAt/counts
# header), the working tree silently ends up on CI's committed checkpoint
# and the local stamps are stranded in an unpopped stash (#893). Turning
# them into a real commit first means a conflict rebases LOUDLY (caught by
# the `if ! git pull` below) instead of vanishing quietly.
git add data/audit/show-review-gap.json data/audit/gap-audit-checkpoint.json data/audit/unknown-aggregator-outlets.json 2>/dev/null || true
if ! git diff --cached --quiet -- data/audit/show-review-gap.json data/audit/gap-audit-checkpoint.json data/audit/unknown-aggregator-outlets.json 2>/dev/null; then
  echo "== Committing + pushing local gap-audit stamps before pull"
  git commit -m "chore: local gap-audit stamps (pre-refresh)" --quiet
  # Push immediately rather than leaving the commit local-only: an unpushed
  # commit here would silently diverge this checkout's main from origin on
  # every send-day run (ship-check finding). push-with-retry.sh already
  # encodes the right conflict policy for this exact file class ("audit/
  # files: keep local run's data") so a real CI-vs-local race resolves the
  # same way it would from any other caller of this script.
  bash scripts/lib/push-with-retry.sh 3 main
fi

echo "== Pulling main repo (per-show score JSONs)"
if ! git pull --rebase --autostash --quiet; then
  # A conflicted rebase leaves the working tree mid-rebase with conflict
  # markers — abort so the repo is clean for the next operator/run instead of
  # stranded (ship-check finding: this failure path bypasses the ERR trap
  # above, since the `if !` guard means `set -e` never sees a bare failure).
  git rebase --abort 2>/dev/null || true
  echo "ERROR: main repo pull failed — public/data/shows would be stale (24-vs-23 incident class), or the just-pushed gap-audit stamps conflicted with a concurrent CI commit. Resolve and re-run." >&2
  exit 1
fi

# Self-heal the anti-repeat ledger against what was ACTUALLY sent in Resend
# BEFORE generating anything new (2026-08-16, #the-pass duplicate). A prior
# regeneration can update data/newsletter-state.json without the matching
# Resend draft ever getting re-PATCHed (or the PATCH silently failing) —
# state.json then disagrees with what subscribers actually received, and the
# next issue's lastFeaturedIds guard trusts the wrong one. Fixing it here
# means every regeneration starts from ground truth, not from whatever the
# last run happened to write.
echo "== Verifying de-dup state against actually-sent broadcasts"
node scripts/newsletter/verify-sent-vs-state.mjs --fix
if ! git diff --quiet -- data/newsletter-state.json; then
  git add data/newsletter-state.json
  git commit -m "chore(newsletter): reconcile de-dup state with actually-sent broadcasts" --quiet
  bash scripts/lib/push-with-retry.sh 3 main
fi

for EDITION in broadway west-end; do
  AUDIENCE=general
  [ "$EDITION" = "west-end" ] && AUDIENCE=west-end
  echo ""
  echo "== [$EDITION] generate"
  NEWSLETTER_EDITION=$EDITION NEWSLETTER_OUT_DIR="$OUT" node scripts/newsletter/generate.mjs "$WEEK"
  # Wrong-week guard: create-broadcast-draft checks meta.edition but not
  # meta.weekStart — if generate ever wrote valid HTML for a different week
  # into A-$WEEK.*, we'd PATCH the draft with the wrong issue unnoticed.
  META_WEEK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/A-$WEEK.meta.json','utf8')).weekStart || '')")
  if [ "$META_WEEK" != "$WEEK" ]; then
    echo "ERROR: generated meta.weekStart '$META_WEEK' != requested week '$WEEK' — aborting before PATCH." >&2
    exit 1
  fi
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
