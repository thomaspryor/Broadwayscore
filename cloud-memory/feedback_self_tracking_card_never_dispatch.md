---
name: self-tracking-card-never-dispatch
description: "A headless/Linear-dispatched session's own startup tracking card (rule 1: notion-brain.js create ... --dispatch/--park required) must use --park, never --dispatch — dispatching it launches a second live cmux workspace duplicating the session's own in-progress work."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 001b9e36-8cc5-4ea6-9e95-69bdec7c5f20
  modified: 2026-08-15T13:17:27.936Z
---

2026-08-15 (BRO-363): this session was itself the auto-dispatched workspace for Linear BRO-363. Per startup-hook rule 1 ("create card immediately for your own tracking card... --dispatch/--park is required on every create"), I ran `notion-brain.js create ... --dispatch`. `bsc-next.js` then launched a brand-new cmux workspace (611/619-adjacent) for that card — a second live session working the exact same Linear issue I was already executing directly in this turn. Both sessions ended up editing the same shared worktree concurrently (a live race, separate from — but same failure shape as — [[feedback_enterworktree_name_collision_live_session]]).

**Why:** `--dispatch` always launches a fresh cmux workspace seeded from the card. That's correct for a *new* discovered work item, but wrong for a card whose entire purpose is tracking work THIS session is already doing — there is no "start work" step left to seed, only a duplicate of the current session.

**How to apply:** when creating a session's own self-tracking card (the rule 1 pattern, printed in every session's startup reminder), always use `--park "already in progress in this session"` instead of `--dispatch`. Reserve `--dispatch` for cards describing work nobody is currently executing. If a duplicate workspace does get spawned this way, don't try to close it yourself (cmux-destructive-guard blocks it without explicit user approval) — instead mark the shared tracking card Done as soon as the real work lands, so the duplicate session's own wrap-up sees current state rather than stale "In progress."

Related: [[notion-brain-workflow]], [[feedback_notion_card_creates_duplicate_task]], [[feedback_enterworktree_name_collision_live_session]]
