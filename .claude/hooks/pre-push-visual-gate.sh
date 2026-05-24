#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks push-ingress commands (git push, gh pr merge,
# bash scripts/lib/push-with-retry.sh, gh workflow run deploy, etc.) when:
#   - UI files changed in `git diff origin/main...HEAD` AND
#   - No "APPROVED: <verdictHash>" from the user in their most recent message AND
#   - No "ship immediately for: <reason>" override active AND
#   - No "NO-VERIFY: <reason>" in last assistant text
#
# Logic is delegated to scripts/lib/transcript-scan.mjs for testability.
# See sprint-plan-visual-qa-gate.md and memory/feedback_local_preview_before_push.md.

# Self-skip if user-level master exists (matches existing hook convention).
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi

# Emergency disable.
[ "${VISUAL_QA_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)

# If we can't see the command or transcript, fail open — don't block legit work.
[ -z "$command" ] && exit 0
[ -z "$transcript" ] && exit 0
[ ! -f "$transcript" ] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$REPO_ROOT" ] && exit 0
SCAN="$REPO_ROOT/scripts/lib/transcript-scan.mjs"
[ ! -f "$SCAN" ] && exit 0

# Quick: is this even a push-ingress command?
PUSH_RESULT=$(node "$SCAN" --query=push-ingress --command="$command" 2>/dev/null)
IS_PUSH=$(echo "$PUSH_RESULT" | jq -r '.isPush // false' 2>/dev/null)
[ "$IS_PUSH" != "true" ] && exit 0

# Are any UI files changed in the branch?
UI_FILES_CHANGED=$(cd "$REPO_ROOT" && git diff --name-only origin/main...HEAD 2>/dev/null | grep -E '^(src/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.|src/app/.*\.(tsx|jsx|ts|js)$)' | head -5)
if [ -z "$UI_FILES_CHANGED" ]; then
  # No UI files changed in this branch — push freely.
  exit 0
fi

# NO-VERIFY override in last assistant text — bypasses gate entirely.
CLAIM_RESULT=$(node "$SCAN" --query=visual-claim-language --transcript="$transcript" 2>/dev/null)
# visual-claim-language returns hasNoVerify if the last asst text has NO-VERIFY:
HAS_NO_VERIFY=$(echo "$CLAIM_RESULT" | jq -r '.hasNoVerify // false' 2>/dev/null)
[ "$HAS_NO_VERIFY" = "true" ] && exit 0

# Override active for THIS push? If so, write the consume marker and pass.
OVERRIDE_RESULT=$(node "$SCAN" --query=override-active-for-push --transcript="$transcript" --session-id="$session_id" --consume=true 2>/dev/null)
OVERRIDE_OK=$(echo "$OVERRIDE_RESULT" | jq -r '.override // false' 2>/dev/null)
if [ "$OVERRIDE_OK" = "true" ]; then
  # Override was matched and consumed. Allow this push; subsequent pushes need
  # fresh approval. Surface a note so the user sees what happened.
  echo "[visual-qa] override accepted (ship immediately for: …). Push unlocked for THIS push only." >&2
  exit 0
fi

# Otherwise: require fresh verdict.json + APPROVED:<hash> in last user message.
BRANCH=$(cd "$REPO_ROOT" && git branch --show-current)
VERDICT_PATH="$REPO_ROOT/.claude/visual-qa/$BRANCH/verdict.json"

if [ ! -f "$VERDICT_PATH" ]; then
  cat >&2 <<EOF
🛑 BLOCKED — push attempted but no visual-qa verdict exists for this branch

  UI files changed in this branch:
$(echo "$UI_FILES_CHANGED" | sed 's/^/    /')

  Run /visual-qa first:
    nohup npm run dev > /tmp/dev.log 2>&1 &
    node scripts/visual-qa.mjs --url http://localhost:3000 \\
      --paths "/,/affected-route" \\
      --elements "<css-sel-of-changed-element>" \\
      --refs <design-ref.png-if-user-provided>

  Then paste the manifest to the user and wait for their reply:
    APPROVED: <verdictHash-shown-by-runner>
  or
    ship immediately for: <reason>          # one-shot override for THIS push only

  Bypass entirely: NO-VERIFY: <reason> in your last assistant message.
EOF
  exit 2
fi

# Verdict exists. Check overallPass + APPROVED hash.
VERDICT_HASH=$(jq -r '.verdictHash // empty' "$VERDICT_PATH" 2>/dev/null)
OVERALL_PASS=$(jq -r '.overallPass // false' "$VERDICT_PATH" 2>/dev/null)

if [ -z "$VERDICT_HASH" ]; then
  cat >&2 <<EOF
🛑 BLOCKED — verdict.json is malformed (no verdictHash field)
  Path: $VERDICT_PATH
  Re-run /visual-qa to regenerate.
EOF
  exit 2
fi

APPROVAL_RESULT=$(node "$SCAN" --query=approval-of "$VERDICT_HASH" --transcript="$transcript" 2>/dev/null)
APPROVED=$(echo "$APPROVAL_RESULT" | jq -r '.approved // false' 2>/dev/null)

if [ "$APPROVED" != "true" ]; then
  cat >&2 <<EOF
🛑 BLOCKED — visual-qa verdict exists but user has not approved this push

  Branch: $BRANCH
  Verdict hash: $VERDICT_HASH
  overallPass: $OVERALL_PASS

  Paste the visual-qa manifest into your reply and ask the user to respond
  with the EXACT phrase:

    APPROVED: $VERDICT_HASH

  Other acceptable responses:
    ship immediately for: <reason>         # one-shot override for THIS push
    NO-VERIFY: <reason>                    # bypass via your next message

  The user's most recent message did not contain "APPROVED: $VERDICT_HASH".
EOF
  exit 2
fi

# All checks passed — allow the push.
if [ "$OVERALL_PASS" != "true" ]; then
  echo "[visual-qa] verdict.overallPass=false but user explicitly APPROVED $VERDICT_HASH. Push allowed." >&2
fi
exit 0
