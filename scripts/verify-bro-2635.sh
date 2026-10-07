#!/usr/bin/env bash
# BRO-2635 acceptance check: gh-poll-block.sh's wrapper-prefix fix.
# Feeds synthetic PreToolUse JSON to the hook directly — never executes the
# guarded gh/git commands themselves (jq -n builds the payload; the hook
# only inspects tool_input.command as a string).
set -euo pipefail

HOOK="$HOME/.claude/hooks/gh-poll-block.sh"
fail=0

check() {
  local desc="$1" cmd="$2" expect="$3"
  local input
  input=$(jq -n --arg c "$cmd" '{tool_name:"Bash", session_id:"verify-bro-2635", tool_input:{command:$c}}')
  local rc=0
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" == "$expect" ]]; then
    echo "PASS ($rc): $desc"
  else
    echo "FAIL (got $rc, want $expect): $desc"
    fail=1
  fi
}

check "wrapped Vercel deploy now blocks" 'timeout 30 gh workflow run "Deploy to Vercel"' 2
check "wrapped gh run watch now blocks"  'timeout 300 gh run watch 12345' 2
check "unwrapped Vercel deploy still blocks (no regression)" 'gh workflow run "Deploy to Vercel"' 2
check "unwrapped gh run watch still blocks (no regression)" 'gh run watch 123' 2
check "FORCE-DEPLOY bypass works through a wrapper" 'timeout 30 gh workflow run "Deploy to Vercel" # FORCE-DEPLOY' 0

exit $fail
