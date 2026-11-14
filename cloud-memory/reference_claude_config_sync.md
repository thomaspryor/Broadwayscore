---
name: claude-config sync repo
description: "~/.claude is a private GitHub repo; use claude-sync push/pull."
type: reference
originSessionId: 989b24bc-a30b-418c-9afc-16fecb90fd4d
---
`~/.claude/` is itself a git repo tracking curated config to `thomaspryor/claude-config` (private).

**Sync is automatic:** session-start.sh auto-pulls, session-stop.sh auto-pushes. Both non-blocking (failures don't disrupt the session). Manual fallback: `claude-sync pull` / `claude-sync push`.

**What's tracked:** CLAUDE.md, settings.json, commands/, hooks/, skills/, bin/claude-sync, Broadwayscore project memory (149 files).

**What's NOT tracked:** sessions/, history.jsonl, paste-cache/, audit logs, runtime state, plugins/cache/, settings.local.json, .pyc, worktree-derived project dirs.

**Portability:** worktree-enforce.sh uses `$BROADWAYSCORE_REPO` env var. settings.json deny rules still hardcode `/Users/tompryor/`. bootstrap-work-mac.sh handles username-mismatch via symlink.
