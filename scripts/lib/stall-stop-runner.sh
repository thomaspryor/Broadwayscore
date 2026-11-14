#!/usr/bin/env bash
# Sourced by home-hook-runner.sh after reading input. Keep the missing-jq path
# independent of jq, just like the bootstrap's missing-runner fallback.
if ! command -v jq >/dev/null 2>&1; then
  if [ "$hook" = verify-edits.sh ] && grep -Eqi 'KEEP OPEN|check(ing)? back|report(ing)? back|I.ll (check|wait|come back|continue|report)|I.m (continuing|waiting)|will (check|report|continue)' <<<"$input" \
     && ! grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<<"$input"; then
    echo 'BLOCKED: jq is missing, so the stall Stop gate cannot confirm a wake for this promise closing. Start a wake or report completed work before stopping again.' >&2
    exit 2
  fi
  printf '%s\n' '{"systemMessage":"BRO-7227: jq is missing; the hook could not run. Install jq to restore hook checks."}'
  exit 0
fi

# Both the app bootstrap and the user Stop entry reach this shared runner.
# Only stall-only calls dedupe: a full finish-chain run must retain its checks.
# Include the closing and retry flag because neither requires transcript growth.
if [ "$hook" = verify-edits.sh ] && [ -n "${VE_ONLY_CODES:-}" ]; then
  identity=$(printf '%s' "$input" | jq -cer 'select(.hook_event_name == "Stop" and (.session_id | type == "string" and length > 0) and (.transcript_path | type == "string" and length > 0)) | [.session_id, .transcript_path, (.last_assistant_message // ""), (.stop_hook_active // false)]' 2>/dev/null)
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$identity" ] && [ -f "$transcript" ] && command -v sha256sum >/dev/null 2>&1; then
    size=$(wc -c < "$transcript" 2>/dev/null)
    if [ -n "$size" ]; then
      digest=$(printf '%s\n' "$identity" "$size" "$VE_ONLY_CODES" | sha256sum)
      lock="${TMPDIR:-/tmp}/bsc-stall-${UID}-${digest%% *}"
      # Atomic even when both hooks start together. An unavailable temp dir
      # must not bypass the gate. Locks live only for this container/turn.
      mkdir -m 700 -- "$lock" 2>/dev/null || { [ ! -d "$lock" ] || exit 0; }
    fi
  fi
  # Check the app copy at the shared runner, so even an old bootstrap gets
  # checked. The duplicate invocation has already exited above. No fetches.
  app_boot="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)}/.claude/hooks/stall-stop-bootstrap.sh"
  if [ -f "$app_boot" ] && ! cmp -s -- "$app_boot" "$R/.claude/hooks/lib/stall-stop-bootstrap.sh"; then
    printf '%s\n' '{"systemMessage":"BRO-7227: stall bootstrap DRIFT: the app copy differs from Broadwayscore. Synchronize .claude/hooks/stall-stop-bootstrap.sh with the canonical copy; stall checks still run."}'
  fi
fi
