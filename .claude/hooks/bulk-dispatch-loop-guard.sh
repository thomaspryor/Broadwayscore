#!/usr/bin/env bash
# PreToolUse hook (BRO-6536, ADVISORY): warn when a Bash command loops bare
# dispatches of a capped bulk workflow (ingest-urls, llm-ensemble-score,
# gather-reviews) instead of scripts/capped-workflow-dispatch.js. On
# 2026-10-29 such session loops queued 359 ingest-urls runs and starved
# land.yml for 2h37m. Always exits 0: the warning reaches the model, the hit
# goes to a ledger (`node scripts/lib/bulk-dispatch-loop-guard.js --report`)
# so a later card can flip it to blocking. Logic + tests live in
# scripts/lib/bulk-dispatch-loop-guard.js(.test.mjs).
#
# Fails open when node or the lib is missing.
# Kill switch: BULK_DISPATCH_GUARD_OFF=1, or the file
# $HOME/.claude/BULK_DISPATCH_GUARD_OFF (a running session cannot change its env).

input=$(cat)
[ "${BULK_DISPATCH_GUARD_OFF:-0}" = "1" ] && exit 0
[ -e "$HOME/.claude/BULK_DISPATCH_GUARD_OFF" ] && exit 0
# Cheap prefilter: most commands never mention a dispatch.
case "$input" in *workflow*|*dispatches*|*cloud-dispatch*) ;; *) exit 0 ;; esac
command -v node >/dev/null 2>&1 || exit 0
LIB="$(cd "$(dirname "$0")/../.." && pwd)/scripts/lib/bulk-dispatch-loop-guard.js"
[ -f "$LIB" ] || exit 0
if command -v timeout >/dev/null 2>&1; then T="timeout 10"
elif command -v gtimeout >/dev/null 2>&1; then T="gtimeout 10"
else T=""
fi
printf '%s' "$input" | $T node "$LIB" 2>/dev/null
exit 0
