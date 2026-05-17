# cloud-memory INDEX.md

For cloud Claude Code sessions. The full memory index is in `MEMORY.md` (102 entries, all sections). This file lists the **top 10 most load-bearing entries** to read first if you only have time for one read.

## Read first (always)

1. **MEMORY.md** — full index, grouped by topic. Start here if you have any context budget at all.
2. **notion-brain-workflow.md** — Notion is the project's roadmap + brain. CLI is `node scripts/notion-brain.js`; MCP is BLOCKED.
3. **email-broadcast-rules.md** — NEVER call `POST /broadcasts/{id}/send` directly. Hard incident rules.

## Common-trap rules

4. **feedback_worktree_code_changes.md** — Any tracked code edit (`src/`, `scripts/`, `.github/workflows/`) must happen in a worktree, never the main repo. Local hooks silently revert otherwise. (Cloud note: cloud sandboxes are already isolated — this rule applies only to local CLI.)
5. **feedback_scoring_delta_required.md** — Edits to scoring logic MUST run `scripts/scoring-delta.js` + the temporal regression fixture before push. Stop hook enforces locally.
6. **feedback_content_quality_regex_fps.md** — Edits to `scripts/lib/content-quality.js` patterns MUST run `node scripts/audit-regex-patterns.js --full`.
7. **feedback_terse_output_default.md** — Output tokens cost ~5x input on Opus. Keep responses terse; verification evidence required but no narration around it.

## Opening-night discipline

8. **feedback_admin_ingest_opening_night_2026-04-26.md** — Consolidated ~42 issues across 2 opening nights. Read FIRST before any opening-night work.
9. **feedback_aggregator_pages_post_opening.md** — Aggregator review pages don't exist pre-opening; 404 pre-opening is normal, don't pre-stage.

## Memory hygiene

10. **feedback_memory_archive_in_place.md** — When pruning, NEVER `git mv` files to `memory/archive/` — source-code comments reference them by path. Use `archived: true` frontmatter instead.

## Cloud-specific notes

- This directory (`cloud-memory/`) is a mirror. **Do not edit files here** — edits get overwritten on next sync from local-authoritative `~/.claude/projects/.../memory/`.
- If you find a learning you want to save, output it to the user with a clear "save this to memory:" preface and the user will commit it from their local session.
- The 359 files with `archived: true` frontmatter are kept for grep but aren't loaded as "active rules." If you grep something out, glance at the frontmatter first.
