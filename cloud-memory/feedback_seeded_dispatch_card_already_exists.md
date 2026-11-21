---
name: feedback_seeded_dispatch_card_already_exists
description: "auto-dispatched sessions are seeded with an existing Notion card URL/ID — don't notion-brain.js create a new tracking card for the same task"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e6c2cc7a-f24f-47fa-83af-cbc62d122baa
  modified: 2026-08-15T04:45:12.936Z
---

When a session's seed prompt names a specific Notion card (URL + task number, e.g. "task #1608 ... Notion: https://app.notion.com/p/..."), that card IS the session's tracking card — it already exists and is already `In progress` (bsc-next stamps it on dispatch). Running `notion-tasks-sync.js pull` immediately after `notion-brain.js create --dispatch` on the same title surfaces `no mirror task id found for this card` and a duplicate task number, and the create step itself can silently make a second card for work already tracked.

**Why:** the seeded card is the handoff — its Notes already carry Problem/Evidence/Suggested approach/Acceptance criteria. `notion-brain.js create` is for *newly discovered* work this session finds, not for re-registering the task it was launched to do.

**How to apply:** at session start, if the prompt gives a card URL/ID, call `notion-brain.js get <id>` to confirm status (usually already `In progress`) instead of `create`. Only `create --dispatch/--park` for genuinely new cards this session originates (discovered follow-up work, [[feedback_notion_card_context.md]]). If a duplicate does get created by mistake, `notion-brain.js archive <id>` it immediately.
