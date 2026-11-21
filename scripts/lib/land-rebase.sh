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

# BRO-7150: a clean rebase can still leave .github/workflows/DEPENDENCIES.md stale (the branch changed a
# workflow edge without regenerating, or main moved the graph); its unit test then refused the land ~25 min
# in. Regenerate it with the rebased tree's own generator and fold it into the branch's last commit: the
# same tree land-branch.js (refreshGeneratedDocsIn) lands. Fails open: no generator, nothing rebased, or a
# generator error leaves HEAD alone and the gauntlet reports the doc as before.
refresh_generated_docs() {
  local gen=scripts/generate-workflow-dependencies.js doc=.github/workflows/DEPENDENCIES.md
  [ -f "$gen" ] || return 0
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$BASE^{commit}" 2>/dev/null)" ] && return 0
  node "$gen" --check >/dev/null 2>&1 && return 0
  if node "$gen" >/dev/null 2>&1 && [ -n "$(git status --porcelain -- "$doc")" ] \
     && git add -- "$doc" && git commit -q --amend --no-edit --no-verify; then
    echo "::notice::$LABEL: $doc was stale on the rebased tree; regenerated it and folded it into the last commit (BRO-7150)"
  else
    git checkout -- "$doc" 2>/dev/null || true
  fi
  return 0
}

# BRO-7631: .gitattributes declares merge drivers a CI runner never registers (git then text-merges silently),
# so bot-regenerated state and the session-cost ledger conflicted and refused ~1 in 3 of 143 checks-job
# rebases. Pass the drivers per command with -c (never stored in config). They come from the BASE tree via
# git show (this script's own copy only carries two files, and the branch may predate them); any missing
# piece, LAND_MERGE_DRIVERS_DISABLED=true or a failure here leaves CARGS empty = today's behaviour.
CARGS=()
load_merge_drivers() {
  [ "${LAND_MERGE_DRIVERS_DISABLED:-}" = "true" ] && return 0
  local d f
  d="$(mktemp -d "${TMPDIR:-/tmp}/land-drivers.XXXXXX")" || return 0
  for f in land-merge-driver.sh merge-keyed-jsonl.js land-merge-drivers.js; do
    git show "$BASE:scripts/lib/$f" >"$d/$f" 2>/dev/null || { echo "::warning::$LABEL: land merge drivers unavailable ($f not on the base tree); rebasing without them (BRO-7631)"; return 0; }
  done
  mapfile -t CARGS < <(node "$d/land-merge-drivers.js" args "$d" 2>/dev/null)
  if [ "${#CARGS[@]}" -gt 0 ]; then echo "::notice::$LABEL: rebasing with the land merge drivers (BRO-7631)"
  else echo "::warning::$LABEL: land merge driver args could not be built; rebasing without them (BRO-7631)"; fi
  return 0
}
load_merge_drivers

# BRO-7631: a rebase stopped on conflicts confined to the generated DEPENDENCIES.md is repaired by regenerating
# it with the generator and continuing, as land-branch.js does in the Land job (BRO-6035). Returns 0 when the
# rebase then finished. Any other conflict, or a generator failure, returns 1 with the rebase left stopped.
resolve_generated_doc_conflicts() {
  local gen=scripts/generate-workflow-dependencies.js doc=.github/workflows/DEPENDENCIES.md step files
  [ -f "$gen" ] || return 1
  for step in $(seq 1 50); do
    files="$(git diff --name-only --diff-filter=U)"
    [ "$files" = "$doc" ] || return 1
    node "$gen" >/dev/null 2>&1 && git add -- "$doc" || return 1
    if GIT_EDITOR=true git ${CARGS[@]+"${CARGS[@]}"} rebase --continue >>"$out" 2>&1; then
      echo "::notice::$LABEL: rebase conflict in $doc only: regenerated it and continued (BRO-6035/7631)"
      return 0
    fi
  done
  return 1
}

attempt=0
while :; do
  git ${CARGS[@]+"${CARGS[@]}"} rebase "$BASE" >"$out" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ] && resolve_generated_doc_conflicts; then rc=0; fi
  cat "$out"
  if [ "$rc" -eq 0 ]; then
    refresh_generated_docs
    exit 0
  fi
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
  echo "::error::$LABEL does not rebase cleanly onto origin/main @ ${BASE:0:10} — merging main into the branch will not help (land replays each commit and drops merges); squash the branch onto fresh origin/main as one commit and push it to a NEW land ref (-v2 suffix)"
  exit 1
done
