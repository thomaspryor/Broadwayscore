#!/usr/bin/env bash
# Stage each pathspec INDEPENDENTLY so a missing one can't abort the whole add.
#
# WHY: `git add A B C` is atomic on pathspec-match failure — if ANY of A/B/C
# matches no file, git add exits 128 and stages NONE of them. In CI commit steps
# this is almost always masked by `2>/dev/null || true`, so a single conditionally
# -written file (first run, feature-flag off, no-change run) silently drops EVERY
# file in that step. This broke opening-night poller backoff + the SERP-session
# ledger for ~1.5 days (2026-06-06 fix). See memory/feedback_silent_git_add_failures.md.
#
# This helper adds each path on its own, skipping ones that don't exist, and never
# fails — so it's safe under `set -e` and behind the usual `|| true`.
#
# Usage:  bash scripts/lib/git-add-existing.sh [--force] PATH [PATH ...]
#   --force / -f : pass through to `git add` (for intentionally-gitignored outputs)
# Globs are expanded by the CALLER's shell; an unmatched literal pattern fails the
# `-e` test and is skipped, so `… public/data/shows/*.social.json` is safe with 0 matches.
set +e

FORCE=""
if [ "$1" = "--force" ] || [ "$1" = "-f" ]; then
  FORCE="--force"
  shift
fi

for p in "$@"; do
  [ -e "$p" ] && git add $FORCE -- "$p"
done

# Never propagate a non-zero status — staging here is always best-effort.
exit 0
