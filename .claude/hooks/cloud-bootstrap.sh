#!/bin/bash
# SessionStart hook: bootstrap a buildable dataset (+ notion client) for cloud
# sessions. No user-level master exists for this one — it is cloud-only by
# design and inert on local CLI, where data/shows.json already resolves (symlink
# into the private repo) and the orchestrator fast-exits. See .claude/CLOUD.md.
#
# Never blocks the session: the orchestrator always exits 0, and this wrapper
# swallows any failure.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BOOT="$REPO_ROOT/scripts/cloud-bootstrap-data.sh"

# Read stdin so the pipe never stalls; only .source is used (BRO-5217: compact
# and clear must not re-copy cloud core data over the session's copies).
SESSION_INPUT="$(cat 2>/dev/null || true)"
BSC_SESSION_EVENT="$(printf '%s' "$SESSION_INPUT" | jq -r '.source // "startup"' 2>/dev/null)"
export BSC_SESSION_EVENT="${BSC_SESSION_EVENT:-startup}"

# BRO-4745: Codex reads hooks and config only from ~/.codex, at startup, so a
# fresh container needs the repo's guards installed before any Codex run.
if command -v codex >/dev/null 2>&1 && [ -f "$REPO_ROOT/scripts/codex/install.js" ]; then
  node "$REPO_ROOT/scripts/codex/install.js" >/dev/null 2>&1 || true
fi

[ -x "$BOOT" ] || [ -f "$BOOT" ] || exit 0
bash "$BOOT" 2>&1 || true
exit 0
