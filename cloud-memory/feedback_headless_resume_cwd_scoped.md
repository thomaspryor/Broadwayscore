---
name: headless-resume-cwd-scoped
description: "claude -p --resume <session-id> only finds transcripts for the CURRENT cwd's project dir — resuming from a different directory fails with \"No conversation found\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b7a3491a-c568-451a-b303-8a7f727dcc3a
  modified: 2026-07-22T00:47:46.569Z
---

`claude --print --resume <session-id>` is **cwd-scoped**: transcripts live under `~/.claude/projects/<cwd-slug>/`, and resume looks only in the current project dir. Resuming a session from any other directory fails with `No conversation found with session ID: …` (verified empirically 2026-07-21).

**Why:** session storage is keyed by working directory, not globally by session ID.

**How to apply:** any headless resume design must re-run from the ORIGINAL cwd. If that dir was ephemeral (e.g. a torn-down worktree), make its path deterministic and recreate it — same path string → same project slug → transcript found. The action dispatcher (scripts/notion-action-poll.js) does this via cardSlug()-deterministic worktree paths + a stored `runDir` hint + a fresh-session-with-context fallback when the transcript is truly gone. Related: [[feedback_worktree_code_changes.md]]
