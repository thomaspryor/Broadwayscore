#!/bin/bash
# Syncs local review-texts changes to the private repo.
# Run this after ANY local modification to data/review-texts/ files.
# CI workflows handle their own pushes — this is for local/Claude sessions only.
#
# --check-only mode:
#   Prints one line of KEY=VAL state and exits. No commits, no pushes.
#   Does `git fetch origin main` with a 5s timeout so it's safe for session-start hooks.
#   Exit code 0 always — the caller interprets the state line.
#   Output: "state=<clean|behind|ahead|diverged|dirty|nogit|nofetch> behind=N ahead=M dirty=<yes|no>"

set -euo pipefail

REVIEW_TEXTS_DIR="$(cd "$(dirname "$0")/../data/review-texts" && pwd)"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
  esac
done

if [ ! -d "$REVIEW_TEXTS_DIR/.git" ]; then
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "state=nogit behind=0 ahead=0 dirty=no"
    exit 0
  fi
  echo "ERROR: $REVIEW_TEXTS_DIR is not a git repo. Clone the private repo first:"
  echo "  git clone https://github.com/thomaspryor/broadway-review-texts.git data/review-texts"
  exit 1
fi

cd "$REVIEW_TEXTS_DIR"

if [ "$CHECK_ONLY" = "1" ]; then
  # Portable 5-second timeout (macOS has no `timeout` by default).
  # Uses perl's alarm() which is available on every macOS + Linux box.
  if ! perl -e 'alarm shift; exec @ARGV' 5 git fetch origin main -q 2>/dev/null; then
    echo "state=nofetch behind=0 ahead=0 dirty=no"
    exit 0
  fi
  BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    DIRTY=no
  else
    DIRTY=yes
  fi
  if [ "$BEHIND" = "0" ] && [ "$AHEAD" = "0" ] && [ "$DIRTY" = "no" ]; then
    STATE=clean
  elif [ "$BEHIND" != "0" ] && [ "$AHEAD" = "0" ] && [ "$DIRTY" = "no" ]; then
    STATE=behind
  elif [ "$BEHIND" = "0" ] && [ "$AHEAD" != "0" ] && [ "$DIRTY" = "no" ]; then
    STATE=ahead
  elif [ "$BEHIND" != "0" ] && [ "$AHEAD" != "0" ]; then
    STATE=diverged
  else
    STATE=dirty
  fi
  echo "state=$STATE behind=$BEHIND ahead=$AHEAD dirty=$DIRTY"
  exit 0
fi

# SAFETY: Pull remote changes FIRST so we don't overwrite data (e.g., fullText)
# that was fetched/committed by other processes while local changes were pending.
git pull --rebase origin main -q 2>/dev/null || true

# Restore protected fields (humanReviewScore, humanReviewedWrongProduction, etc.)
# from pre-rebase HEAD. ORIG_HEAD is set by git when a rebase replayed commits.
# If remote's version of a file overwrote a manual correction that only existed
# in our pre-rebase HEAD, copy it back. Covers bucket H (fix-doesn't-propagate).
RPF="$(cd "$(dirname "$0")" && pwd)/lib/restore-protected-fields.js"
if [ -f "$RPF" ] && git rev-parse ORIG_HEAD >/dev/null 2>&1; then
  node "$RPF" ORIG_HEAD >/dev/null 2>&1 || true
fi

# Check for changes
git add -A
if git diff --staged --quiet; then
  echo "No review-texts changes to sync."
  exit 0
fi

# Protect fetched review text: for any staged review-text JSON where local has
# fullText=null but the committed (post-pull) version has fullText, restore it.
# This prevents simulation/rebuild metadata write-backs from wiping fetched text.
node -e "
  const fs = require('fs');
  const { execSync } = require('child_process');
  const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  let restored = 0;
  for (const f of staged) {
    if (!f.endsWith('.json') || f.includes('failed-fetches')) continue;
    try {
      const local = JSON.parse(fs.readFileSync(f, 'utf8'));
      const committed = JSON.parse(execSync('git show HEAD:' + f, { encoding: 'utf8' }));
      if (committed.fullText && !local.fullText) {
        local.fullText = committed.fullText;
        local.textFetchedAt = committed.textFetchedAt || local.textFetchedAt;
        local.textWordCount = committed.textWordCount || local.textWordCount;
        local.isFullReview = committed.isFullReview != null ? committed.isFullReview : local.isFullReview;
        local.textStatus = committed.textStatus || local.textStatus;
        local.contentTier = committed.contentTier || local.contentTier;
        local.contentTierReason = committed.contentTierReason || local.contentTierReason;
        local.wordCount = committed.wordCount || local.wordCount;
        if (committed.contentVerification) local.contentVerification = committed.contentVerification;
        fs.writeFileSync(f, JSON.stringify(local, null, 2) + '\n');
        restored++;
        console.log('  Restored fullText for ' + f);
      }
    } catch (e) { /* file not in HEAD or parse error — skip */ }
  }
  if (restored > 0) console.log('  Protected ' + restored + ' file(s) from fullText data loss');
" 2>/dev/null || true

# Re-stage after protection pass
git add -A
if git diff --staged --quiet; then
  echo "No review-texts changes to sync (all changes were stale)."
  exit 0
fi

CHANGED=$(git diff --staged --stat | tail -1)
echo "Changes: $CHANGED"

# Commit
COMMIT_MSG="${1:-data: Sync local review-texts changes}"
git commit -m "$COMMIT_MSG" -m "Changed: $CHANGED"

# Push with retry
for i in 1 2 3 4 5; do
  if git pull --rebase origin main 2>&1; then
    # Resolve any conflicts by keeping ours (local is always newer for local sessions)
    UNMERGED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    if [ -n "$UNMERGED" ]; then
      echo "Resolving $( echo "$UNMERGED" | wc -l | tr -d ' ') conflicts (keeping local versions)..."
      echo "$UNMERGED" | while IFS= read -r f; do
        git checkout --theirs "$f" 2>/dev/null || true
        git add "$f"
      done
      GIT_EDITOR=true git rebase --continue 2>/dev/null || true
    fi

    # Restore protected fields after the retry rebase too.
    if [ -f "$RPF" ] && git rev-parse ORIG_HEAD >/dev/null 2>&1; then
      node "$RPF" ORIG_HEAD >/dev/null 2>&1 || true
      # Re-stage anything restore-protected-fields rewrote
      git add -A 2>/dev/null || true
      git commit --amend --no-edit 2>/dev/null || true
    fi

    if git push origin main 2>&1; then
      echo "Review-texts synced successfully (attempt $i)."
      exit 0
    fi
  fi

  echo "Attempt $i failed, retrying in 5s..."
  git rebase --abort 2>/dev/null || true
  sleep 5
done

echo "ERROR: Failed to sync after 5 attempts."
exit 1
