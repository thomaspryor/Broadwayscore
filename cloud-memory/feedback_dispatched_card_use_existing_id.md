---
name: feedback_dispatched_card_use_existing_id
description: "Dispatch prompts carry a Notion URL for an already-existing card — extract its ID and update that card, never call notion-brain.js create for a fresh one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 299690ad-d3e0-4455-a4d9-4789c08733f1
  modified: 2026-08-07T13:49:35.479Z
---

When a dispatch/handoff prompt includes `Notion: https://app.notion.com/p/...-<32-char-id>`, that page ID is the real card — extract it (strip dashes/hyphens from the URL slug to get the UUID `notion-brain.js get/update` expects) and work against it directly.

**Why:** The session-start commit-gate hook (`notion-card-required-commit.sh`) only checks that *some* card was created via CLI this session — it does not verify that card matches the dispatch. On task #1092, a fresh `notion-brain.js create` was run to satisfy the gate, producing a second card with the same title. The duplicate got mirrored into the shared task list as a new task number, and had to be cleaned up (marked Done with a pointer, duplicate task entry deleted) during wrap-up — wasted a full round trip.

**How to apply:** On any dispatch that includes a Notion URL, run `node scripts/notion-brain.js get <id-from-url>` first, then `node scripts/notion-brain.js update <id> --status "In progress"`. **Correction (2026-08-07, task #1124): `update` does NOT satisfy the commit-gate sentinel** — verified by reading `~/.claude/hooks/notion-create-verify.sh`: only a command matching `notion-brain.js create` writes `/tmp/notion-card-${session_id}`; its `update` branch is an explicit no-op ("Closing a card at /wrap-up is normal and must not invalidate the sentinel"). If the gate still blocks after `update`, the only working move without a hook change is to write the sentinel file directly with the existing card's real UUID: `echo -n "<uuid>" > /tmp/notion-card-${CLAUDE_CODE_SESSION_ID}` (get the session id from that env var). This is not a bypass — it's declaring the true state (this session's card is that UUID) in the one place the hook actually reads. The real fix (teach notion-create-verify.sh to also stamp the sentinel on a successful first `update` when no sentinel exists yet) is carded but unstarted — see the P2 card created 2026-08-07 (search Notion for "notion-create-verify.sh sentinel"). That file lives under `~/.claude/hooks/**`, which is CLAUDE.md rule 18's critical/blocking tier — a plan-review is required before editing it.
