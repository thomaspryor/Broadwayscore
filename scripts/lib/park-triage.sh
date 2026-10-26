#!/usr/bin/env bash
# park-triage.sh park|restore  (BRO-4521, data-health-check.yml)
#
# data/audit/triage/ is written by several steps of data-health-check.yml but
# committed only by the job's LAST push step, because the directory had no
# Git Data API fallback (BRO-2782 since registered audit/triage/*.json as
# apiFallbackMerge; this parking predates it and still works). It was not
# apiFallbackSafe, so
# an earlier commit of it would disqualify every later step's fallback,
# BRO-2538). Left dirty, it made every intermediate push-with-retry.sh call
# log "rebase REFUSED ... You have unstaged changes" and fall to the merge
# fallback.
#
#   park     copy changed/new triage files to $RUNNER_TEMP/triage-parked,
#            record deleted ones, and restore the tree to HEAD. Run right
#            after each step that writes triage/. Repeated calls accumulate;
#            a later park of the same file wins (it is the newer write).
#   restore  put everything back (the final commit step, before git add).
#
# Never commits or pushes.
set -uo pipefail
P="${RUNNER_TEMP:-/tmp}/triage-parked"
D="$P.deleted"
T=data/audit/triage/

case "${1:-}" in
  park)
    mkdir -p "$P"; touch "$D"
    git -c core.quotePath=false ls-files -d -- "$T" >> "$D"
    sort -u -o "$D" "$D"
    n=0
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      mkdir -p "$P/$(dirname "$f")"; cp -p "$f" "$P/$f"; n=$((n + 1))
      # Re-created after an earlier park recorded it deleted: keep it.
      grep -vxF -- "$f" "$D" > "$D.tmp"; mv "$D.tmp" "$D"
    done < <({ git -c core.quotePath=false diff --name-only --diff-filter=d -- "$T"; git -c core.quotePath=false ls-files -o --exclude-standard -- "$T"; } | sort -u)
    git checkout -- "$T" 2>/dev/null || true
    git clean -fdq -- "$T"
    echo "parked $n changed/new and $(wc -l < "$D") deleted triage file(s) (total held: $(find "$P" -type f | wc -l))"
    git status --short -- "$T" | head -5
    ;;
  restore)
    if [ -d "$P/data" ]; then cp -pR "$P/data/." data/; fi
    if [ -s "$D" ]; then while IFS= read -r f; do rm -f "$f"; done < "$D"; fi
    ;;
  *) echo "usage: $0 park|restore" >&2; exit 2 ;;
esac
