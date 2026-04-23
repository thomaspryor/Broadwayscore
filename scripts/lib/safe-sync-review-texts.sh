#!/usr/bin/env bash
# Safe sync + push for thomaspryor/broadway-review-texts (and broadway-scorecard-data).
#
# REPLACES the dangerous "git reset --hard origin/main && rsync local→repo"
# pattern that Tom used interactively during the Beaches 2026-04-22 opening
# night. That pattern silently wipes CI-added fields (llmScore, llmMetadata,
# ensembleData, pullQuote, etc.) that landed between our last pull and our
# attempted push — it resets to origin's state (which HAS those fields) and
# then rsync overwrites with our local copy (which lacks them).
#
# This helper:
#   1. Pulls with rebase (field-additive merge; never resets).
#   2. After the rebase, runs restore-protected-fields.js to detect and
#      restore any MANUAL_FIELDS/PROTECTED_FIELDS that the rebase dropped.
#   3. Pushes normally; retries up to 5x with backoff on push rejection.
#   4. On fatal conflict, REFUSES to proceed. The operator must resolve by
#      hand — NOT by reset-hard + rsync.
#
# Usage:
#   bash scripts/lib/safe-sync-review-texts.sh [REPO_DIR]
#
# REPO_DIR defaults to $HOME/broadway-review-texts. For the core-data repo:
#   bash scripts/lib/safe-sync-review-texts.sh $HOME/broadway-scorecard-data
#
# Exits 0 on success, 1 on failure (with diagnostics). Never calls reset --hard.

set -euo pipefail

REPO_DIR="${1:-$HOME/broadway-review-texts}"
BRANCH="${2:-main}"
MAX_RETRIES=5

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repo"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE_JS="$SCRIPT_DIR/restore-protected-fields.js"

cd "$REPO_DIR"

# Safety 1: refuse to run if the working tree has unstaged diff to protected
# file types. Caller should stage + commit first.
if ! git diff --quiet -- '*.json' 2>/dev/null; then
  echo "ERROR: unstaged JSON changes in $REPO_DIR"
  echo "       Commit your changes first — this helper will NOT rsync/reset over them."
  git status --short -- '*.json' | head -20
  exit 1
fi

# Safety 2: refuse if there's a partial rebase or merge in progress.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "ERROR: rebase or merge in progress in $REPO_DIR"
  echo "       Resolve or abort it first: 'git rebase --abort' / 'git merge --abort'"
  exit 1
fi

echo "=== Safe sync: $REPO_DIR ($BRANCH) ==="

# Pull with rebase. -X theirs keeps OUR commits' versions on conflict — meaning
# when CI added a field to a file we also touched, our side wins. Then
# restore-protected-fields.js recovers anything CI had that we didn't.
for attempt in $(seq 1 "$MAX_RETRIES"); do
  echo "Pull attempt $attempt/$MAX_RETRIES..."

  if ! git fetch origin "$BRANCH"; then
    echo "  fetch failed; retrying..."
    sleep $((5 + RANDOM % 10))
    continue
  fi

  # Rebase if we're behind. If we're already in sync, skip.
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")
  BASE=$(git merge-base HEAD "origin/$BRANCH")

  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "  Already at origin/$BRANCH."
  elif [ "$LOCAL" = "$BASE" ]; then
    # We're strictly behind — fast-forward.
    echo "  Fast-forwarding to origin/$BRANCH..."
    git merge --ff-only "origin/$BRANCH"
  else
    # Diverged. Rebase -X theirs keeps OUR local commits' content.
    if git rebase -X theirs "origin/$BRANCH"; then
      echo "  Rebase succeeded."
      # Restore CI-added fields that may have been dropped by -X theirs.
      if [ -x "$(command -v node)" ] && [ -f "$RESTORE_JS" ]; then
        echo "  Checking for CI-added protected fields to restore..."
        COUNT=$(node "$RESTORE_JS" "origin/$BRANCH" 2>&1 | tail -1)
        if [ "$COUNT" -gt 0 ] 2>/dev/null; then
          echo "  Restored protected fields in $COUNT file(s)."
          git add -A
          if ! git diff --cached --quiet; then
            git commit --amend --no-edit >/dev/null 2>&1 || true
          fi
        fi
      fi
    else
      # Conflicts the rebase strategy couldn't resolve — REFUSE to reset.
      echo "::error::Rebase had unresolvable conflicts in $REPO_DIR."
      echo "        DO NOT run 'git reset --hard origin/main && rsync' to escape."
      echo "        That wipes CI-added fields (llmScore, ensembleData, etc.)."
      echo "        Resolve per-file with 'git status' + 'git diff --name-only --diff-filter=U',"
      echo "        then 'git add' + 'git rebase --continue'."
      git rebase --abort >/dev/null 2>&1 || true
      exit 1
    fi
  fi

  # Push.
  if git push origin "$BRANCH"; then
    echo "  Push succeeded on attempt $attempt."
    exit 0
  fi

  echo "  Push rejected (someone else committed); retrying in $((5 + attempt * 2))s..."
  sleep $((5 + attempt * 2))
done

echo "::error::All $MAX_RETRIES push attempts failed for $REPO_DIR."
exit 1
