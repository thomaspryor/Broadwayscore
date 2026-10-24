#!/usr/bin/env bash
# PreToolUse hook on create_session (BRO-6088): advisory warning when this session's own
# Linear card is plan-only. Never denies; fails open. Logic: scripts/lib/plan-only-create-session.js.
# Kill switch: PLAN_ONLY_CREATE_SESSION_DISABLE=1.
[ -n "$PLAN_ONLY_CREATE_SESSION_DISABLE" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
root="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$root/scripts/plan-only-create-session-hook.js" ] || exit 0
node "$root/scripts/plan-only-create-session-hook.js" 2>/dev/null
exit 0
