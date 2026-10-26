#!/usr/bin/env bash
# PreToolUse hook on the Gmail connector's outgoing tools (BRO-6285). Denies an
# email to the owner that asks them to reply or decide; decisions go through a
# DECISION NEEDED card. Matcher logic: scripts/lib/owner-email-ask-guard.js.
# Bypass: a `NO-OWNER-EMAIL-CHECK: <reason>` line in the body. Fails open on
# missing jq/node or unparseable input. Kill switch: OWNER_EMAIL_GUARD_DISABLE=1.

[ -n "$OWNER_EMAIL_GUARD_DISABLE" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

input="$(cat)"
root="$(cd "$(dirname "$0")/../.." && pwd)"
reason="$(printf '%s' "$input" | jq -c '.tool_input // {}' 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
const r=require(process.argv[1]).checkOwnerEmail(JSON.parse(s));
if(r.blocked)process.stdout.write(r.reason);}catch(e){}});' "$root/scripts/lib/owner-email-ask-guard.js" 2>/dev/null)"
[ -z "$reason" ] && exit 0
jq -n --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
