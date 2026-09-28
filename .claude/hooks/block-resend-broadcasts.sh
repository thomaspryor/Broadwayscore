#!/usr/bin/env bash
# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there
# (BRO-4238: CLAUDE.md §17 email safety had no guard in cloud).
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
# PreToolUse hook: BLOCK direct calls to Resend's broadcasts API.
#
# Why this exists:
#   Three real subscriber-broadcast incidents documented in
#   cloud-memory/email-broadcast-rules.md. CLAUDE.md rule 16 says broadcast
#   sends MUST route through the gated wrapper (send-lock + preview-dedup +
#   completed-flag). On 2026-05-24, Claude created a Resend broadcast draft
#   by running an inline `node -e` POST to api.resend.com/broadcasts from
#   the Bash tool — bypassing every safeguard. This hook enforces what
#   rule 16 only stated.
#
# What it blocks:
#   Any Bash command containing `resend.com/broadcasts` (host-loose so it
#   future-proofs against `broadcasts.resend.com` etc.). Catches curl, wget,
#   node -e, python -c, fetch(), and any other shell-invoked HTTP path to
#   the broadcasts endpoint.
#
# What it does NOT block:
#   - The three sanctioned wrappers (scripts/send-opening-night-broadcast.js,
#     scripts/fantasy-weekly-email.js, scripts/newsletter/create-broadcast-draft.mjs).
#     They call the API in-process, so the Bash hook only sees `node scripts/...`
#     in the command string and lets it through. Their internal safeguards
#     (send-lock/preview-dedup; the newsletter wrapper is draft-only with no
#     send path) remain the active gate for those paths.
#   - CI workflows. PreToolUse hooks fire on Claude Code's Bash tool, not on
#     GitHub Actions runners.
#   - `git commit` invocations that mention the URL in a commit message.
#     BRO-2645: this used to be a whole-command exemption (mirroring
#     gh-poll-block.sh's pre-BRO-2639 bug) — `git commit -m "x"; curl -X POST
#     .../broadcasts/ID/send` rode it free, with no backstop of any kind for
#     this hook (unlike gh-poll-block.sh's zombie reaper). Now only the commit
#     MESSAGE TEXT is shielded (via hooks/lib/strip-git-commit-noise.js,
#     shared with gh-poll-block.sh), so a real chained call is still caught.
#
# Known limitation (intentional):
#   String-concatenation evasion (`node -e "const u='https://api.resend'+'.com/broadcasts'..."`)
#   defeats the regex. The threat model here is well-meaning Claude blocked
#   from a slip, not an adversarial Claude. Accept it.
#
# Bypass (one inline marker, matches gh-poll-block.sh's # FORCE-DEPLOY shape):
#   Add `# BROADCAST_AUTHORIZED_BY=<email>` anywhere in the command. The
#   marker forces the human's authorization to live in the SAME shell
#   command as the API hit, so the audit trail is the command itself.

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)

[[ "$tool_name" != "Bash" ]] && exit 0

command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -z "$command" ]] && exit 0

# BRO-2645: shield only the commit MESSAGE TEXT (and heredoc bodies) from the
# URL scan below, via the module built for BRO-2639 (gh-poll-block.sh) — NOT
# a whole-command exemption. FAIL-OPEN: if node/the module is unavailable,
# fall back to the ORIGINAL whole-command exemption (is_git_commit) rather
# than a new failure mode — same philosophy as gh-poll-block.sh and
# infra-plan-review-gate.sh.
STRIP_LIB="$HOME/.claude/hooks/lib/strip-git-commit-noise.js"
# Repo copy (cloud): the lib ships next to this script (BRO-4238). Without it
# the guard would fall back to exempting any command with `git commit` in it
# (the BRO-2645 hole: `git commit ...; curl .../send`).
[[ -f "$STRIP_LIB" ]] || STRIP_LIB="$(cd "$(dirname "$0")" && pwd)/lib/strip-git-commit-noise.js"
scan_command="$command"
strip_ok=0
if [[ -f "$STRIP_LIB" ]] && command -v node >/dev/null 2>&1; then
  _STRIP_SRC='
    try {
      const mod = require(process.env.STRIP_LIB);
      process.stdout.write(mod.stripForDangerScan(process.env.CMD_TO_STRIP || ""));
    } catch (e) { /* leave stdout empty — caller falls back */ }
  '
  if command -v timeout >/dev/null 2>&1; then
    stripped=$(STRIP_LIB="$STRIP_LIB" CMD_TO_STRIP="$command" timeout 5 node -e "$_STRIP_SRC" 2>/dev/null)
  else
    stripped=$(
      STRIP_LIB="$STRIP_LIB" CMD_TO_STRIP="$command" node -e "$_STRIP_SRC" 2>/dev/null &
      _np=$!
      ( sleep 5; kill -9 $_np 2>/dev/null ) &
      _wd=$!
      wait $_np 2>/dev/null
      kill $_wd 2>/dev/null
    )
  fi
  if [[ -n "$stripped" ]]; then
    scan_command="$stripped"
    strip_ok=1
  fi
fi

# Fallback-only whole-command exemption (BRO-2645): applies exclusively when
# strip_ok=0 (node/module unavailable) — the pre-BRO-2645 behavior, preserved
# as a safety net. Wrapper-prefix group (timeout/env/nohup/nice/command)
# mirrors gh-poll-block.sh's BRO-2635 fix.
is_git_commit=$(echo "$command" | grep -qE '(^|;|&&|\|\|)\s*(cd [^;&]+\s*(;|&&)\s*)?(timeout\s+\S+\s+|env(\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+|nohup\s+|nice\s+(-n\s*\S+\s+)?|command\s+)*git commit' 2>/dev/null && echo 1 || echo 0)
if [[ "$strip_ok" != "1" && "$is_git_commit" == "1" ]]; then
  exit 0
fi

# Match resend's broadcasts endpoint, host-loose. Catches both:
#   - api.resend.com/broadcasts          (current host + path)
#   - broadcasts.resend.com              (hypothetical future subdomain)
# Two alternations because the broadcast surface lives at either the path
# /broadcasts on api.resend.com, OR (if Resend ever splits) a dedicated host.
# Scans $scan_command (BRO-2645) so a real chained call after a commit is
# still caught instead of riding the old blanket exemption free.
if echo "$scan_command" | grep -qE '(resend\.com/broadcasts|broadcasts\.resend\.com)' 2>/dev/null; then
  # Allow the inline bypass marker (audit trail visible in the command itself).
  if echo "$command" | grep -qE '#[[:space:]]*BROADCAST_AUTHORIZED_BY=' 2>/dev/null; then
    exit 0
  fi

  cat >&2 <<'EOF'
[automation note — owner can ignore] 🛑 RESEND BROADCAST GUARD: direct resend.com/broadcasts API call blocked (it skips send-lock, dedup and the sent-flag).
Use a wrapper: scripts/send-opening-night-broadcast.js, scripts/fantasy-weekly-email.js,
  or node scripts/newsletter/create-broadcast-draft.mjs <weekStart> --create (draft only, never sends).
Only if the user authorized a direct call THIS turn, put the marker in the same command:
  curl -X POST https://api.resend.com/broadcasts …  # BROADCAST_AUTHORIZED_BY=tom
Full rules: ~/.claude/hooks/GATES.md
EOF
  exit 2
fi

exit 0
