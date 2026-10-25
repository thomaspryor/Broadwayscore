---
name: notion-brain-workflow
description: "RETIRED. Notion is no longer the board; see linear-board-workflow.md."
metadata:
  node_type: memory
  type: feedback
---

## Retired (2026-09-29, BRO-4274)

The Notion "project brain" is retired. Linear is the board of record (CLAUDE.md §6):
read [linear-board-workflow.md](linear-board-workflow.md) for the card lifecycle.

Do not run `notion-brain.js create|update` for session tracking: create exits 6, and an
update no longer satisfies any close-out gate. Historical Notion page IDs in old notes
(e.g. `34b637c5...`) are provenance only.
