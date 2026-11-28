---
name: feedback-notion-notes-replaces-outcome-appends
description: notion-brain.js update --notes REPLACES the whole Notes field while --outcome APPENDS; a follow-up --notes silently destroys Problem/Evidence/Approach on a card you just wrote
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 499e32ab-c6f4-4ad4-a348-ef9ceabbf5f0
  modified: 2026-08-06T14:20:22.965Z
---

`node scripts/notion-brain.js update <id> --notes "..."` **overwrites** the entire
Notes field. `--outcome "..."` **appends**. The two flags behave oppositely and
nothing warns you.

The trap: you create a card with a full handoff body, then later add a section
(acceptance criteria, a new finding) with a second `--notes` call. The card
silently drops from ~2500 chars to ~500 — Problem, Evidence, Suggested approach,
What was already tried, all gone. The command exits 0.

Hit on 2026-08-06 on two P1 cards (#1094, #1095) while adding the runnable
acceptance criteria `bsc-next --id` requires before it will dispatch. Both had to
be rewritten from scratch.

**Why:** find out AFTER the fact and the original body is unrecoverable — it was
never committed anywhere, and the conversation that composed it may be gone.

**How to apply:** to add to Notes, compose the FULL new body (old + new) in one
`--notes` call. Write it in a quoted heredoc in a scratch script, never inline —
inline backticks in the body get command-substituted by the shell and silently
eat whatever they wrap (this ate a "git apply <file>" example and a
"sed --in-place" example out of a Done card's outcome the same session). Then
verify what actually landed: `notion-brain.js get <id>` and check the section
headers survived. Related: [[feedback_notion_create_verify]],
[[feedback_notion_card_context]].
