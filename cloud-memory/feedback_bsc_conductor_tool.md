---
name: feedback_bsc_conductor_tool
description: "bsc-conductor CLI exists — one-word fresh orchestrator session, replaces keeping an interactive session alive for multi-day dispatch/forensics work"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 561c2768-1e87-4702-98df-cbbc40d6b64c
---

`bsc-conductor` (alias in `~/.zshrc` → `scripts/bsc-conductor.js`) opens a fresh interactive `claude --model opus --effort high` session pre-seeded with a live orientation sweep: `bsc-next --list`, last 20 `autonomous-ledger.jsonl` entries, `bsc-prune --dry-run`, open cmux workspaces, `morning-radar.js`, and Notion `needs-approval`/`P0 Now` cards. The sweep runs as plain `child_process` calls (no LLM turns), so the launched session can report an accurate state-of-the-world in its first message instead of spending several tool calls re-deriving it.

**Why it exists:** the 3-day interactive "Fable" orchestration session (2026-07-11 → 2026-07-14) proved the conductor ROLE (dispatch, forensics, cross-session judgment, single point of conversation) is valuable, but an immortal session is the costliest way to host it — long context re-read every turn, at the expensive default model tier. All orchestration state already lives outside any one session (shared task list, ledger, Notion, cmux workspaces), so a fresh `bsc-conductor` session reconstructs it in ~1 min instead.

**How to apply:** when the user wants an orchestrator/dispatcher session (not implementation work), suggest `bsc-conductor` instead of staying in a long-lived session yourself. The seed carries 7 standing rules baked in (dispatch-don't-implement, pin models on every fan-out, card every discovery, converse with the owner, no paste-prompts, no human-territory picks, stay disposable — [[feedback_worktree_code_changes.md]] for why dispatched work still needs a worktree). Task card: #168 (Notion 39d637c5-416f-81b9-bc0d-f087402e6bc3). Sibling tool: [[feedback_notion_card_context.md]] `bsc-next` (dispatches a single task into a cmux workspace) — `bsc-conductor` is the orientation+launch layer on top, not a replacement for it.
