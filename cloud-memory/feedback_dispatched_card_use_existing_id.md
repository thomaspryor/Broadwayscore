---
name: feedback_dispatched_card_use_existing_id
description: "Dispatch prompts carry a Notion URL for an already-existing card — extract its ID and update that card, never call notion-brain.js create for a fresh one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 299690ad-d3e0-4455-a4d9-4789c08733f1
  modified: 2026-08-06T20:07:34.854Z
---

When a dispatch/handoff prompt includes `Notion: https://app.notion.com/p/...-<32-char-id>`, that page ID is the real card — extract it (strip dashes/hyphens from the URL slug to get the UUID `notion-brain.js get/update` expects) and work against it directly.

**Why:** The session-start commit-gate hook (`notion-card-required-commit.sh`) only checks that *some* card was created via CLI this session — it does not verify that card matches the dispatch. On task #1092, a fresh `notion-brain.js create` was run to satisfy the gate, producing a second card with the same title. The duplicate got mirrored into the shared task list as a new task number, and had to be cleaned up (marked Done with a pointer, duplicate task entry deleted) during wrap-up — wasted a full round trip.

**How to apply:** On any dispatch that includes a Notion URL, run `node scripts/notion-brain.js get <id-from-url>` first. If the commit-gate hook still blocks (it wants a CLI `create` call this session), that's a known hook gap — update the *existing* card's status to "In progress" via `notion-brain.js update` (which the gate should also satisfy) rather than creating a parallel one. Only call `create` when no card exists yet.
