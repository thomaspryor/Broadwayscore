#!/usr/bin/env bash
# relaunch-claude-tab.sh — the ONE sanctioned way to (re)start an interactive
# claude from anything that is not the owner's own typing (BRO-4065).
#
# Why this exists: ~/.config/claude/keychain-sentinel.sh deletes the keychain
# login every 5 minutes by design, so every claude authenticates ONLY through
# CLAUDE_CODE_OAUTH_TOKEN. ~/.zshrc exports it for interactive shells, but
# Claude Code strips it from its own Bash tool env, launchd jobs never had it,
# and a `cmux respawn-pane --command` runs in cmux's app env without it. Any
# claude started from one of those places comes up "Not logged in · Please
# run /login" (BRO-4056: 10+ tabs died this way). This wrapper re-exports the
# token from .env when it is missing, then execs claude via PATH (so the cmux
# claude shim, and with it cmux's session hooks, still wraps it).
#
# Usage:
#   relaunch-claude-tab.sh [--cwd DIR] [claude args...]
#     e.g. relaunch-claude-tab.sh --cwd ~/Broadwayscore --resume <session-id> --dangerously-skip-permissions
#   relaunch-claude-tab.sh --check     exit 0 if a token is available (prints SET/MISSING, never the token)
#
# Env: BSC_ENV_FILE overrides the .env path (tests); CLAUDE_BIN overrides the
# claude binary (tests). Exit 3 = no token anywhere (refuses rather than
# starting yet another logged-out tab).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# .env is the source of truth and wins over an inherited token: a tab shell
# started before a token rotation still exports the OLD one, and resuming
# with it just fails auth again. The inherited token is only the fallback.
load_token() {
  local f v
  for f in "${BSC_ENV_FILE:-}" "$repo_root/.env" "$HOME/Broadwayscore/.env"; do
    [ -n "$f" ] && [ -r "$f" ] || continue
    # Same parse as ~/.zshrc: first match, strip surrounding quotes.
    v="$(grep -m1 '^CLAUDE_CODE_OAUTH_TOKEN=' "$f" 2>/dev/null | cut -d= -f2- | tr -d "\"'" || true)"
    if [ -n "$v" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$v"; return 0; fi
  done
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]
}

if [ "${1:-}" = "--check" ]; then
  if load_token; then echo SET; exit 0; else echo MISSING; exit 3; fi
fi

cwd=""
if [ "${1:-}" = "--cwd" ]; then
  [ $# -ge 2 ] || { echo "relaunch-claude-tab: --cwd needs a directory" >&2; exit 2; }
  cwd="$2"; shift 2
fi

if ! load_token; then
  echo "relaunch-claude-tab: no CLAUDE_CODE_OAUTH_TOKEN in the environment or .env — refusing to start a claude that would come up logged out" >&2
  exit 3
fi

if [ -n "$cwd" ]; then cd "$cwd"; fi
exec "${CLAUDE_BIN:-claude}" "$@"
