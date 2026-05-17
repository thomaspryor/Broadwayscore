# cloud-memory/

Mirror of the local user-level Claude Code memory directory, committed to this repo so cloud Claude Code sessions (claude.ai/code, iOS, Mac app) can read accumulated learnings.

**Authoritative source:** `~/.claude/projects/-Users-tompryor-Broadwayscore/memory/` (local-only — Anthropic's auto-memory loader reads from there). Cloud apps can't reach that path, hence this mirror.

**Sync:** `scripts/sync-memory-to-repo.sh` (rsync; idempotent; runs from `~/.claude/hooks/session-stop.sh` on every local session exit and as a fallback step in `/wrap-up` Phase 5).

**Do not edit files here directly.** Edits to mirror files will be overwritten on the next sync. Edit the source dir or via Claude Code's memory system; sync propagates the change.

## Cloud sessions: start here

Before you start work, cat `INDEX.md` (highest-leverage rules first) and `MEMORY.md` (the full index). Then read whichever specific `feedback_*.md` / `project_*.md` files the index points at.

## Why the file count is so high

359 of the files have `archived: true` frontmatter. They're kept for grep + hardcoded source-comment refs but don't appear in the auto-rebuilt index. Only ~100 files are "live" (referenced from `MEMORY.md`).
