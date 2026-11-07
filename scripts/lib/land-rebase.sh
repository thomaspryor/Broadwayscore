#!/usr/bin/env bash
# land-rebase.sh — land.yml's "Rebase onto origin/main" core (BRO-4165).
#
#   bash land-rebase.sh <base-sha> [<label>]
#
# Rebases HEAD onto <base-sha> in a blobless checkout (fetch-depth: 0 +
# filter: blob:none). A rebase there can die with `upload-pack: not our ref
# <blob>` / `could not fetch <blob> from promisor remote` and NO conflict
# (BRO-4141 class, runs 36098224017 / 36097498416 / 36093056455): a lazy-fetch
# batch names a blob the rebase itself just wrote. A fresh process sees the
# blobs the failed pass wrote, so retrying is the cure — the same decision
# push-with-retry.sh and land-branch.js make, via the one classifier
# scripts/lib/promisor-fetch-failure.js (CLAUDE.md §15: never a second regex).
#
# Exit 0 = rebased. Exit 1 = real conflict / ordinary failure (message says
# resolve the conflict). Exit 3 = promisor lazy-fetch failure that survived
# every retry: infrastructure, NOT a conflict, message says re-push to retry.
# land.yml runs this from a copy taken off the BASE tree (the land branch may
# predate the script), together with promisor-fetch-failure.js beside it.
set -uo pipefail

BASE="${1:?usage: land-rebase.sh <base-sha> [label]}"
LABEL="${2:-${BRANCH:-HEAD}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RETRIES="${LAND_REBASE_PROMISOR_RETRIES:-3}"

out="$(mktemp "${TMPDIR:-/tmp}/land-rebase.XXXXXX")"
trap 'rm -f "$out"' EXIT

attempt=0
while :; do
  git rebase "$BASE" >"$out" 2>&1
  rc=$?
  cat "$out"
  [ "$rc" -eq 0 ] && exit 0
  git rebase --abort >/dev/null 2>&1 || true
  # Classifier failing (exit 2 / missing node) must never widen the retry.
  if node "$HERE/promisor-fetch-failure.js" "$out" 2>/dev/null; then
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$RETRIES" ]; then
      echo "::error::$LABEL: rebase onto ${BASE:0:10} failed $RETRIES retries with a partial-clone lazy-fetch error (promisor remote / not our ref). This is NOT a merge conflict — do not resolve anything; re-push the branch to retry."
      exit 3
    fi
    echo "::warning::land rebase hit a partial-clone lazy-fetch failure ($(git --version 2>/dev/null || echo 'git ?')) — retry $attempt/$RETRIES (BRO-4165): $(tail -c 400 "$out" | tr '\n' ' ')"
    continue
  fi
  echo "::error::$LABEL does not rebase cleanly onto origin/main @ ${BASE:0:10} — resolve the conflict on the branch and push again"
  exit 1
done
