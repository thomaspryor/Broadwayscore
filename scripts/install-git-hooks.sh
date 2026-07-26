#!/usr/bin/env bash
# Install repo git hooks into .git/hooks/.
#
# Run once per clone. Idempotent — re-running upgrades to the latest hook.
#
# Usage: bash scripts/install-git-hooks.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC="${REPO_ROOT}/scripts/git-hooks"
DST="${REPO_ROOT}/.git/hooks"

if [ ! -d "$SRC" ]; then
  echo "❌ Hook source dir not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DST"

for hook in "$SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  cp "$hook" "$DST/$name"
  chmod +x "$DST/$name"
  echo "✓ installed $name"
done

if ! command -v gitleaks >/dev/null 2>&1; then
  echo ""
  echo "⚠️  gitleaks is not installed. The pre-commit hook will skip the scan."
  echo "   Install: brew install gitleaks"
fi

echo ""
echo "Done. Hooks active in .git/hooks/."
