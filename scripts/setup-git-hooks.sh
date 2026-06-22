#!/bin/bash
# Setup git hooks for this repo by pointing core.hooksPath at scripts/hooks/.
# This makes the hooks version-controlled (vs the default .git/hooks/ which
# isn't tracked) so every contributor gets the same pre-push checks.
#
# Run once per clone:
#   ./scripts/setup-git-hooks.sh
#
# Idempotent. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not inside a git repo." >&2
  exit 1
fi

CURRENT="$(git config --local --get core.hooksPath 2>/dev/null || true)"
DESIRED="scripts/hooks"

if [ "$CURRENT" = "$DESIRED" ]; then
  echo "Already configured: core.hooksPath = $DESIRED"
else
  git config --local core.hooksPath "$DESIRED"
  echo "Set core.hooksPath = $DESIRED"
  if [ -n "$CURRENT" ]; then
    echo "(was: $CURRENT)"
  fi
fi

# Sanity check that the hook is executable.
if [ ! -x "$REPO_ROOT/$DESIRED/pre-push" ]; then
  chmod +x "$REPO_ROOT/$DESIRED/pre-push"
  echo "Made $DESIRED/pre-push executable."
fi

echo ""
echo "Pre-push hook active. Audits that run on push:"
echo "  - audit-tests-vs-derived-data.js (if tests/unit/* changed)"
echo "  - audit-orphan-tests.js (if tests/unit/* changed)"
echo "  - audit-playwright-evaluate-click.js (if tests/e2e/* changed)"
echo "  - tsc --noEmit (if *.ts/*.tsx changed)"
echo ""
echo "Bypass for emergencies: git push --no-verify"
