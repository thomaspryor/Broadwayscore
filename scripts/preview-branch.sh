#!/usr/bin/env bash
# preview-branch.sh — open one of the autonomous loop's branches in a browser.
#
#   npm run preview-branch auto/some-branch-name
#
# Why this exists: when the overnight loop changes how a page LOOKS and could
# not take screenshots, the morning email withholds the Approve button and
# tells the owner to look at the page first (scripts/lib/autonomous-email-render.js
# renderItem). "Open the branch on your Mac" is not an instruction a
# non-developer can follow, so the email hands them THIS command instead — one
# paste, no git knowledge. It must keep working, or the email is telling the
# owner to do something impossible (ship-check finding, 2026-07-25).
#
# Disposable: builds a throwaway worktree, fills in the gitignored bits
# (node_modules + core-data symlinks) the same way the loop's own check runner
# does, starts the dev server, opens the browser, and cleans up on Ctrl-C.
set -euo pipefail

BRANCH="${1:-}"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "--help" ] || [ "$BRANCH" = "-h" ]; then
  cat <<'USAGE'
preview-branch — look at one of the overnight loop's branches in your browser.

Usage:
  npm run preview-branch auto/some-branch-name

Opens that version of the site at http://localhost:4321 and leaves it running.
Press Ctrl-C in this window when you are done — everything it created is
thrown away automatically.
USAGE
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
PORT="${PREVIEW_PORT:-4321}"
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/preview-branch-XXXXXX")/wt

cleanup() {
  echo ""
  echo "[preview] cleaning up..."
  git -C "$REPO_ROOT" worktree remove --force "$WORKDIR" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$WORKDIR")" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[preview] fetching ${BRANCH}..."
git -C "$REPO_ROOT" fetch origin "$BRANCH" >/dev/null 2>&1 || {
  echo "[preview] could not find a branch called '$BRANCH' on GitHub."
  echo "[preview] It may already have been merged or rejected — nothing to look at."
  exit 1
}
git -C "$REPO_ROOT" worktree add --detach "$WORKDIR" FETCH_HEAD >/dev/null

echo "[preview] preparing..."
# Same gap-filling the loop's check runner does: a fresh worktree has no
# node_modules and none of the gitignored core-data symlinks.
node -e "require('$REPO_ROOT/scripts/lib/autonomous-checks.js').prepareCheckWorkdir('$WORKDIR', '$REPO_ROOT')"
# `|| true`: a missing .env is normal on a fresh clone and must not trip `set -e`.
[ -f "$REPO_ROOT/.env" ] && ln -sf "$REPO_ROOT/.env" "$WORKDIR/.env" || true

echo "[preview] starting the site at http://localhost:$PORT (first load takes ~30s)"
(
  sleep 25
  command -v open >/dev/null && open "http://localhost:$PORT" || true
) &

cd "$WORKDIR"
NEXT_PUBLIC_FEATURES='criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions,userAccounts' \
NEXT_PUBLIC_SANITY_PROJECT_ID=fp1ft8k8 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_SANITY_API_VERSION=2024-10-01 \
  npx next dev -p "$PORT"
