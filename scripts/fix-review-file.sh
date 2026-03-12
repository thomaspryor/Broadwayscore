#!/bin/bash
# Fix a review file in the private review-texts repo and push.
#
# Usage:
#   bash scripts/fix-review-file.sh <show-id>/<filename> '{"wrongShow": true, "assignedScore": null}'
#
# This is the ONLY safe way to edit review files locally.
# DO NOT edit data/review-texts/ files directly — local copies are stale.
# This script pulls latest, applies the fix, commits, and pushes.

set -euo pipefail

REVIEW_TEXTS_DIR="data/review-texts"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <show-id/filename.json> '<json-fields-to-set>'"
  echo "Example: $0 every-brilliant-thing-2026/theatrely--rachel-hsu.json '{\"wrongShow\": true}'"
  exit 1
fi

FILE_PATH="$1"
FIELDS="$2"
FULL_PATH="$REVIEW_TEXTS_DIR/$FILE_PATH"

# Verify the review-texts dir is a git repo (private repo checkout)
if [ ! -d "$REVIEW_TEXTS_DIR/.git" ]; then
  echo "ERROR: $REVIEW_TEXTS_DIR is not a git repo. Run setup-local-data.sh first."
  exit 1
fi

# Step 1: Pull latest from private repo
echo "Pulling latest from private review-texts repo..."
cd "$REVIEW_TEXTS_DIR"
git pull origin main --rebase

# Step 2: Verify file exists
if [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH"
  echo "Available files in $(dirname "$FILE_PATH"):"
  ls "$(dirname "$FILE_PATH")" 2>/dev/null || echo "  (directory not found)"
  exit 1
fi

# Step 3: Apply JSON field updates
echo "Applying fixes to $FILE_PATH..."
node -e "
const fs = require('fs');
const f = '$FILE_PATH';
const fields = $FIELDS;
const data = JSON.parse(fs.readFileSync(f, 'utf8'));

for (const [key, value] of Object.entries(fields)) {
  const old = data[key];
  data[key] = value;
  console.log('  ' + key + ': ' + JSON.stringify(old) + ' → ' + JSON.stringify(value));
}

fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
console.log('File updated.');
"

# Step 4: Commit and push
git add "$FILE_PATH"
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

COMMIT_MSG="fix: Update $FILE_PATH ($(echo "$FIELDS" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const f=JSON.parse(d);console.log(Object.keys(f).join(', '))"))"
git commit -m "$COMMIT_MSG"
git push origin main

echo ""
echo "✅ Pushed to private repo. Now trigger a rebuild:"
echo "   gh workflow run \"Rebuild Reviews Data\" -f reason=\"Fix: $FILE_PATH\""
