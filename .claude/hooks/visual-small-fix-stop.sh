#!/usr/bin/env bash
# Stop hook (BRO-7298): a session that pushed a small UI fix through the visual gate's small-fix lane (no pre-push yes)
# may not close until it sent the owner a screenshot of the live page. Logic: scripts/lib/visual-small-fix.mjs --stop-hook
# (silent when this session used no lane; own block budget; kill VISUAL_SMALL_FIX_STOP_DISABLED=1; fails open).
# Mac/local only: cloud containers run the same check from verify-edits.sh, the one Stop hook wired in every cached
# container, so this file skips there to avoid a double block.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && exit 0
[ "${VISUAL_SMALL_FIX_STOP_DISABLED:-0}" = "1" ] && exit 0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
LIB="$ROOT/scripts/lib/visual-small-fix.mjs"
[ -f "$LIB" ] && command -v node >/dev/null 2>&1 || exit 0
input=$(cat)
_err=$(printf '%s' "$input" | timeout 15 node "$LIB" --stop-hook 2>&1 >/dev/null); _s=$?
if [ $_s -eq 2 ]; then printf '%s\n' "$_err" >&2; exit 2; fi
exit 0
