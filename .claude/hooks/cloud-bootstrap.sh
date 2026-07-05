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

# Drain stdin (SessionStart delivers JSON we don't need) so the pipe never stalls.
cat >/dev/null 2>&1 || true

[ -x "$BOOT" ] || [ -f "$BOOT" ] || exit 0
bash "$BOOT" 2>&1 || true
exit 0
