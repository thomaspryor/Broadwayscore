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
echo "--- Core Data (9 files from broadway-scorecard-data) ---"

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

if [ "$AUTH_METHOD" = "gh" ]; then
  if ! gh repo clone thomaspryor/broadway-scorecard-data "$TEMP_DIR/core-data" -- --depth 1 2>/dev/null; then
    echo "ERROR: Failed to clone broadway-scorecard-data. Check your access permissions."
    exit 1
  fi
else
  if ! git clone --depth 1 "https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-scorecard-data.git" "$TEMP_DIR/core-data" 2>/dev/null; then
    echo "ERROR: Failed to clone broadway-scorecard-data. Check your access permissions."
    exit 1
  fi
fi

COUNT=0
for f in "$TEMP_DIR/core-data"/*.json; do
  [ -f "$f" ] || continue
  cp -f "$f" "$DATA_DIR/"
  COUNT=$((COUNT + 1))
  echo "  Copied $(basename "$f")"
done
echo "Core data: $COUNT files copied to data/"

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
