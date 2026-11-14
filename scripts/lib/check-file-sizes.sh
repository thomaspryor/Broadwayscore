#!/usr/bin/env bash
# Large-file detector for data/ (BRO-5335). Workflows call it inside their
# commit step, after `git add` and before `git commit`, so the staged set is
# what will really be committed; runnable locally from the repo root.
#
#   bash scripts/lib/check-file-sizes.sh [--advisory]
#
# --advisory (how every workflow calls it while the post-stage placement
# proves itself, CLAUDE.md section 19): findings are ::warning:: lines and the
# script ALWAYS exits 0, even if it crashes, so a commit step can never fail
# or stop before committing (rebuild-reviews.yml stages alert-cooldown state
# in the same step). Arming = drop the flag from the call sites.
#
# What it looks at: everything under data/ a commit step could pick up, i.e.
# every path that differs from HEAD (staged or not) plus untracked files that
# are NOT gitignored. The old version read only `git diff --cached`, but 16 of
# its 18 call sites run before their commit step stages anything, so it always
# passed. Gitignored files stay out (March 2026: scanning gitignored
# diary-shows.json and mezzanine raw data blocked 5 scoring runs).
#
# Rules (a finding is one of):
#   - new file (not in HEAD) over 5MB, unless its basename is in ALLOW_LARGE;
#   - tracked file that crosses 5MB this run, or grows by more than 5MB
#     (catches a bug bloating a small audit file; known-large ledgers that
#     grow a little each run are fine);
#   - any file over the 90MiB hard cap (GitHub rejects pushes at 100MiB;
#     stage-latency.jsonl did that on 2026-07-05).
#
# Severity: a finding in a STAGED file exits 1, as before. A finding only in
# an unstaged or untracked file is a ::warning:: plus a step-summary line and
# exits 0, while the wider scan proves itself (CHECK_FILE_SIZES_ENFORCE_ALL=1
# makes those exit 1 too).
#
# ALLOW_LARGE decision for the tracked files already over 5MB (BRO-5335):
# data/audit/scraper-spend-ledger.jsonl, show-review-gap.json,
# aggregator-coverage.json, data/archive/notion-card-history.jsonl and the two
# data/audit/shows-pre-*backfill*.json snapshots are NOT allowlisted. They are
# in HEAD, so only the crossing / >5MB-jump rules apply to them: routine
# growth passes, a sudden 5MB jump is the bloat this exists to catch.
set -uo pipefail

ADVISORY=""
BAD_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --advisory) ADVISORY=1 ;;
    *) BAD_ARGS="$BAD_ARGS $arg" ;;
  esac
done
if [ -n "$ADVISORY" ]; then
  # Never fail the caller, whatever happens below (including a crash).
  trap 'rc=$?; [ "$rc" -ne 0 ] && echo "::warning::check-file-sizes exited $rc (advisory mode, not failing the step)"; exit 0' EXIT
fi
if [ -n "$BAD_ARGS" ]; then
  echo "check-file-sizes: unknown argument(s):$BAD_ARGS (usage: check-file-sizes.sh [--advisory])" >&2
  exit 2
fi

LIMIT=5242880       # 5 MiB
HARD_CAP=94371840   # 90 MiB
# Legitimately large files that may be (re)created. stage-latency.jsonl is an
# append-only audit log that self-rotates at 40MB (scripts/lib/stage-latency.js).
ALLOW_LARGE="llm-scoring-runs.json llm-scoring-garbage-skips.json master-review-list.json reviews.json shows.json show-score.json stage-latency.jsonl"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

size_of() { stat --format=%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

if ! git rev-parse --verify -q HEAD >/dev/null; then
  # No HEAD (empty repo): nothing to diff against, so every file is new.
  echo "::warning::check-file-sizes: no HEAD commit; treating every data/ file as new"
fi

declare -A STAGED=()
while IFS= read -r -d '' f; do STAGED["$f"]=1; done < <(git diff --cached --no-renames --name-only -z --diff-filter=ACM -- data/ 2>/dev/null)

declare -A SEEN=()
CANDIDATES=()
add() { [ -n "$1" ] && [ -z "${SEEN[$1]:-}" ] && { SEEN["$1"]=1; CANDIDATES+=("$1"); }; }
while IFS= read -r -d '' f; do add "$f"; done < <(git diff --no-renames --name-only -z --diff-filter=ACM HEAD -- data/ 2>/dev/null)
while IFS= read -r -d '' f; do add "$f"; done < <(git diff --cached --no-renames --name-only -z --diff-filter=ACM -- data/ 2>/dev/null)
while IFS= read -r -d '' f; do add "$f"; done < <(git ls-files --others --exclude-standard -z -- data/ 2>/dev/null)

errors=""
warnings=""
for file in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
  [ -f "$file" ] || continue
  size=$(size_of "$file")
  base=$(basename "$file")
  old=$(git cat-file -s "HEAD:$file" 2>/dev/null || echo "")
  reason=""
  if [ "$size" -gt "$HARD_CAP" ]; then
    reason="$size bytes, over the 90MiB hard cap (GitHub rejects pushes at 100MiB)"
  elif [ -z "$old" ]; then
    if [ "$size" -gt "$LIMIT" ] && ! in_list "$base" "$ALLOW_LARGE"; then
      reason="new file, $size bytes (over 5MB)"
    fi
  elif [ "$size" -gt "$LIMIT" ] && { [ "$old" -le "$LIMIT" ] || [ $((size - old)) -gt "$LIMIT" ]; } && ! in_list "$base" "$ALLOW_LARGE"; then
    reason="grew from $old to $size bytes"
  fi
  [ -z "$reason" ] && continue
  if [ -n "${STAGED[$file]:-}" ] || [ "${CHECK_FILE_SIZES_ENFORCE_ALL:-}" = "1" ]; then
    errors="${errors}${file}: ${reason}"$'\n'
  else
    warnings="${warnings}${file}: ${reason}"$'\n'
  fi
done

if [ -n "$warnings" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && echo "::warning::Large data file a commit step may pick up: $line"
  done <<< "$warnings"
  { echo "### Large data files (not staged yet)"; echo '```'; printf '%s' "$warnings"; echo '```'; } >> "$SUMMARY"
fi
if [ -n "$errors" ] && [ -n "$ADVISORY" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && echo "::warning::Large staged data file (advisory, would fail once armed): $line"
  done <<< "$errors"
  { echo "### Large staged data files (advisory)"; echo '```'; printf '%s' "$errors"; echo '```'; } >> "$SUMMARY"
  echo "If this is a legitimate data file, add it to the private core-data repo instead (or to ALLOW_LARGE in scripts/lib/check-file-sizes.sh)."
  exit 0
fi
if [ -n "$errors" ]; then
  echo "::error::Large files detected that should not be committed:"
  printf '%s' "$errors"
  echo ""
  echo "If this is a legitimate data file, add it to the private core-data repo instead (or to ALLOW_LARGE in scripts/lib/check-file-sizes.sh)."
  exit 1
fi
echo "File size check passed (${#CANDIDATES[@]} changed or new data/ file(s) checked)"  # set-u-safe: ${#arr[@]} is defined for an empty array
