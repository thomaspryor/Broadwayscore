#!/usr/bin/env bash
# commit-or-amend.sh <upstream-ref> [message]
#
# Folds staged reconciliation changes into "our" commit WITHOUT rewriting the
# remote's own tip (BRO-4688).
#
# `git pull --rebase` silently DROPS our commit when its patch is already
# upstream ("dropping <sha> -- patch contents already upstream"), leaving HEAD
# == the remote's tip. A plain `git commit --amend` after the post-rebase
# reconciliation then REWRITES THAT REMOTE COMMIT (same parent, new hash), so
# the push is non-fast-forward on every retry no matter how quiet the remote
# is: 12x "Rebuild Reviews (Fast)" retries-exhausted in a week, run 37282766663
# (remote idle for the whole 70s retry window, 5/5 rejected).
#
# If HEAD has no commits beyond <upstream-ref>, make a NEW commit on top;
# otherwise amend as before. An unresolvable/empty <upstream-ref> keeps the
# legacy amend. Exit status is git commit's, so callers keep their `|| true`.
set -u
UPSTREAM="${1:-}"
MSG="${2:-data: reconcile after concurrent push}"
if [ -n "$UPSTREAM" ] && git rev-parse --verify -q "${UPSTREAM}^{commit}" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "${UPSTREAM}..HEAD" 2>/dev/null || echo 1)
  if [ "$AHEAD" = "0" ]; then
    exec git commit --allow-empty -m "$MSG"
  fi
fi
exec git commit --amend --no-edit --allow-empty
