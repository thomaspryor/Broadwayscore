#!/bin/bash
# Setup git hooks for this repo by pointing core.hooksPath at scripts/hooks/.
# This makes the hooks version-controlled (vs the default .git/hooks/ which
# isn't tracked) so every contributor gets the same pre-push checks.
#
# Run once per clone:
#   ./scripts/setup-git-hooks.sh
#
# Idempotent. Safe to re-run.
#
# WORKTREES: core.hooksPath lives in the shared .git/config (not per-worktree),
# so every worktree runs the MAIN CHECKOUT's scripts/hooks/*, not its own
# working copy — a session editing a hook file is silently testing the
# unmodified main-checkout version until that edit is merged. To exercise a
# worktree-local hook edit before merging, override explicitly:
#   git -c core.hooksPath=scripts/hooks commit -m "..."
# (discovered while verifying card #1825's pre-commit manifest auto-sort)

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

# Sanity check that every hook is executable.
for hook in pre-push pre-commit commit-msg; do
  if [ -f "$REPO_ROOT/$DESIRED/$hook" ] && [ ! -x "$REPO_ROOT/$DESIRED/$hook" ]; then
    chmod +x "$REPO_ROOT/$DESIRED/$hook"
    echo "Made $DESIRED/$hook executable."
  fi
done

echo ""
echo "Hooks active (pre-push, pre-commit, commit-msg). Pre-push audits:"
echo "  - audit-tests-vs-derived-data.js (if tests/unit/* changed)"
echo "  - audit-orphan-tests.js (if tests/unit/* changed)"
echo "  - audit-playwright-evaluate-click.js (if tests/e2e/* changed)"
echo "  - lint-write-routing.sh (if scripts/*.js changed — same lint CI runs)"
echo "  - tsc --noEmit (if *.ts/*.tsx changed)"
echo ""
echo "Bypass for emergencies: git push --no-verify"
