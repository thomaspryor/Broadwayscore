---
name: cmux-closed-tab-restore-recipe
description: How to restore closed cmux workspaces with their Claude sessions intact (2026-07-21 mass-close incident recipe)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f80a3aa3-df0c-4787-a582-819e28e9deb5
  modified: 2026-07-21T18:29:54.908Z
---

Closing a cmux workspace kills its claude process but NOT the conversation — transcripts persist and resume cleanly. Full restore recipe (used 2026-07-21 to recover 10 tabs closed by a rogue bsc-prune sweep):

1. **Identify victims**: `cmux list-workspaces` vs what the user expects. Transcript project dirs are keyed by cwd: main-repo sessions live in `~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl`, worktree sessions in `…-Broadwayscore--claude-worktrees-<name>/`. Victims of a mass-close all share the same last-mtime (the kill moment). Locked entries in `git worktree list` mark worktrees that had live sessions.
2. **Confirm no orphan process** (else resume conflicts): `ps aux | grep claude` + `lsof -p <pid> -d cwd`.
3. **Restore each**: `cmux new-workspace --name "<orig title> (restored)" --cwd <orig cwd> --command " bash <script>" --focus false` where the script runs `claude --resume <session-uuid>`. Use the script-file indirection (bsc-next.js pattern) — typing the command raw races shell init. cwd MUST match the transcript's project dir or resume won't find the session.
4. **Verify**: `cmux top --workspace workspace:N --processes --format tsv` has a `process` row parented to `…:tag:claude_code`.

**Why:** tabs die silently (prune bugs, crashes); the user's instinct is that the work is lost — it isn't.
**How to apply:** never re-drive lost sessions from scratch; always resume by uuid. Who ran a destructive sweep: grep `~/.claude/projects/**/*.jsonl` for the command, check tool_use timestamps. Related: [[feedback_never_close_unmarked_cmux_workspaces]].
