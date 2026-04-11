#!/bin/bash
# Setup local data files from private repos
# Run this after cloning the public repo to get the data files needed for local dev.
#
# Prerequisites:
#   - GitHub CLI (gh) authenticated with access to thomaspryor private repos
#   OR
#   - REVIEW_TEXTS_TOKEN environment variable set (PAT with repo scope)
#
# Usage:
#   ./scripts/setup-local-data.sh           # Setup core data only
#   ./scripts/setup-local-data.sh --all     # Setup core data + review texts

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/data"

echo "=== Broadway Scorecard Local Data Setup ==="
echo ""

# Determine auth method (token takes priority if explicitly set)
TOKEN="${REVIEW_TEXTS_TOKEN:-}"
if [ -n "$TOKEN" ]; then
  echo "Using REVIEW_TEXTS_TOKEN for authentication..."
  AUTH_METHOD="token"
elif command -v gh &>/dev/null; then
  echo "Using GitHub CLI for authentication..."
  AUTH_METHOD="gh"
else
  echo "ERROR: No authentication method available."
  echo ""
  echo "Option 1: Install and authenticate GitHub CLI"
  echo "  brew install gh && gh auth login"
  echo ""
  echo "Option 2: Set REVIEW_TEXTS_TOKEN environment variable"
  echo "  export REVIEW_TEXTS_TOKEN=ghp_your_token_here"
  exit 1
fi

# Setup core data files
echo ""
echo "--- Core Data (from broadway-scorecard-data) ---"

# Clone the private core-data repo to a STABLE local path so we can symlink
# data/shows.json and data/reviews.json to it. The symlinks mean local edits
# write directly to the private repo — avoiding the dual-repo sync gotcha
# where CI's "Checkout core data" step silently overwrites public-repo edits.
# See memory/feedback_dual_repo_data_files.md for full context.
CORE_DATA_DIR="$HOME/broadway-scorecard-data"

if [ -d "$CORE_DATA_DIR/.git" ]; then
  echo "Updating existing core-data clone at $CORE_DATA_DIR..."
  (cd "$CORE_DATA_DIR" && git fetch origin main --depth 1 && git reset --hard origin/main) >/dev/null 2>&1 || {
    echo "ERROR: Failed to update existing $CORE_DATA_DIR — delete it and re-run."
    exit 1
  }
else
  echo "Cloning broadway-scorecard-data to $CORE_DATA_DIR..."
  if [ "$AUTH_METHOD" = "gh" ]; then
    if ! gh repo clone thomaspryor/broadway-scorecard-data "$CORE_DATA_DIR" -- --depth 1 2>/dev/null; then
      echo "ERROR: Failed to clone broadway-scorecard-data. Check your access permissions."
      exit 1
    fi
  else
    if ! git clone --depth 1 "https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-scorecard-data.git" "$CORE_DATA_DIR" 2>/dev/null; then
      echo "ERROR: Failed to clone broadway-scorecard-data. Check your access permissions."
      exit 1
    fi
  fi
fi

# Files that should be symlinks (so local edits write through to private repo)
SYMLINK_FILES=(shows.json reviews.json)

# Files that should be regular copies (read-only for most purposes)
COPY_FILES=(audience-buzz.json audience-reviews-lbo.json awards.json commercial.json critic-consensus.json critic-registry.json diary-shows.json grosses.json grosses-history.json mezzanine-productions-raw.json opening-night-sent.json outlet-registry.json)

SYMLINK_COUNT=0
for f in "${SYMLINK_FILES[@]}"; do
  src="$CORE_DATA_DIR/$f"
  dst="$DATA_DIR/$f"
  if [ ! -f "$src" ]; then
    echo "  WARN: $f missing in core-data repo, skipping"
    continue
  fi
  # If there's a regular file at the destination, back it up first (don't trash tracked data).
  if [ -f "$dst" ] && [ ! -L "$dst" ]; then
    mv "$dst" "${dst}.pre-symlink-backup"
    echo "  Backed up existing $f → ${f}.pre-symlink-backup"
  elif [ -L "$dst" ]; then
    rm "$dst"
  fi
  ln -s "$src" "$dst"
  SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  echo "  Linked $f → $src"
done

COPY_COUNT=0
for f in "${COPY_FILES[@]}"; do
  src="$CORE_DATA_DIR/$f"
  [ -f "$src" ] || continue
  cp -f "$src" "$DATA_DIR/"
  COPY_COUNT=$((COPY_COUNT + 1))
done
echo "Core data: $SYMLINK_COUNT symlinked, $COPY_COUNT copied to data/"

# Verify key files
if [ ! -f "$DATA_DIR/shows.json" ] || [ ! -f "$DATA_DIR/reviews.json" ]; then
  echo "WARNING: shows.json or reviews.json missing after copy!"
fi

# Optional: setup review texts
if [ "${1:-}" = "--all" ]; then
  echo ""
  echo "--- Review Texts (from broadway-review-texts) ---"
  echo "This may take a few minutes (~234 MB)..."

  mkdir -p "$DATA_DIR/review-texts"

  if [ "$AUTH_METHOD" = "gh" ]; then
    if ! gh repo clone thomaspryor/broadway-review-texts "$TEMP_DIR/review-texts" -- --depth 1 2>/dev/null; then
      echo "ERROR: Failed to clone broadway-review-texts. Check your access permissions."
      exit 1
    fi
  else
    if ! git clone --depth 1 "https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-review-texts.git" "$TEMP_DIR/review-texts" 2>/dev/null; then
      echo "ERROR: Failed to clone broadway-review-texts. Check your access permissions."
      exit 1
    fi
  fi

  # Copy review text directories (exclude .git and aggregator-archive)
  rsync -a --exclude='.git' --exclude='aggregator-archive' "$TEMP_DIR/review-texts/" "$DATA_DIR/review-texts/"
  RT_COUNT=$(find "$DATA_DIR/review-texts" -name "*.json" -type f | wc -l | tr -d ' ')
  echo "Review texts: $RT_COUNT files copied to data/review-texts/"

  # Copy aggregator-archive to its own directory
  if [ -d "$TEMP_DIR/review-texts/aggregator-archive" ]; then
    mkdir -p "$DATA_DIR/aggregator-archive"
    rsync -a "$TEMP_DIR/review-texts/aggregator-archive/" "$DATA_DIR/aggregator-archive/"
    AA_COUNT=$(find "$DATA_DIR/aggregator-archive" -type f | wc -l | tr -d ' ')
    echo "Aggregator archive: $AA_COUNT files copied to data/aggregator-archive/"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo "Run 'npm run dev' to start the development server."
