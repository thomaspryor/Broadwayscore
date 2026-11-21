#!/bin/bash
# Repro: the local task mirror never learns a card closed.
# For each id, print the local mirror status next to Notion's authoritative status.
usage() {
  cat <<'USAGE'
repro-stale-mirror.sh <task-id> [task-id ...]

Prints each task's LOCAL mirror status (~/.claude/tasks/broadwayscore/<id>.json)
beside Notion's authoritative status (notion-brain.js get).

Exits 0 when every checked card agrees, 1 when any card is stale — "pending"
locally while Notion reports Done/Paused (bsc-next ranks a finished card as
dispatchable), OR "in_progress" locally while Notion reports Done/Paused/
Archived/Cancelled (worse: scripts/bsc-reconcile.js's stall sweep selects
in_progress mirrors directly, off the local file, with no Notion check in
that path — a stale in_progress entry is a standing RE-DISPATCH candidate,
not just a ranking one; task #1778, confirmed live 2026-08-18 via task #1773
stall-redispatched 24 minutes after its card closed).

Read-only: makes no writes to Notion, the mirror, or the repo.
USAGE
}
for a in "$@"; do
  case "$a" in -h|--help) usage; exit 0;; esac
done
[ $# -eq 0 ] && { usage; exit 2; }

cd ~/Broadwayscore || exit 2
D=~/.claude/tasks/broadwayscore
stale=0; checked=0
for id in "$@"; do
  f="$D/$id.json"; [ -f "$f" ] || continue
  mirror=$(python3 -c "import json;print(json.load(open('$f')).get('status'))")
  url=$(node scripts/bsc-next.js --id "$id" --dry-run 2>/dev/null | grep -m1 -oE '[0-9a-f]{32}')
  [ -z "$url" ] && continue
  notion=$(node scripts/notion-brain.js get "$url" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
  checked=$((checked+1))
  is_stale=0
  if [ "$mirror" = "pending" ] && { [ "$notion" = "Done" ] || [ "$notion" = "Paused" ]; }; then
    is_stale=1
  elif [ "$mirror" = "in_progress" ] && { [ "$notion" = "Done" ] || [ "$notion" = "Paused" ] || [ "$notion" = "Archived" ] || [ "$notion" = "Cancelled" ]; }; then
    is_stale=1
  fi
  if [ "$is_stale" -eq 1 ]; then
    stale=$((stale+1)); printf 'STALE  #%-6s mirror=%-9s notion=%s\n' "$id" "$mirror" "$notion"
  else
    printf 'ok     #%-6s mirror=%-9s notion=%s\n' "$id" "$mirror" "$notion"
  fi
done
echo "---"
echo "stale mirror entries: $stale / $checked checked"
[ "$stale" -eq 0 ]
