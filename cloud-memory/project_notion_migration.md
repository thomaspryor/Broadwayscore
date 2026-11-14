---
name: Memory-to-Notion migration plan
description: "4 project/incident memory files migrated to Notion 2026-03-27."
type: project
archived: true
---

## Memory → Notion Migration

**Why:** memory/ files are only visible to Claude. Project state, incident history, and operational knowledge should live in Notion so Tom can see them too. Claude behavioral rules ("when you do X, do it this way") stay as memory files.

**How to apply:** Next session with Notion MCP connected, create these as pages under the BWSC parent page (`32b637c5-416f-80aa-8001-e84d503ce3c1`).

### Files to migrate to Notion pages

| Memory file | Notion page title | Why move |
|---|---|---|
| `project_opening_night_debt.md` | Opening Night Incident History | Incident postmortem + remaining debt — Tom needs visibility |
| `project_commercial_fix.md` | Commercial Scorecard Overhaul | Architecture decisions Tom should see |
| `project_commercial_postmortem_extraction.md` | Commercial Backfill Status | Progress tracking belongs in Notion |
| `email-broadcast-rules.md` | Email Broadcast Safety Rules | Critical incident history + hard rules |

### After migration
- Create the Notion pages with full content from each memory file
- Add a "Reference" section in each Notion page linking to related roadmap cards
- Update the memory files to be stubs pointing to Notion: "Migrated to Notion. See [page title] under BWSC."
- Do NOT delete the memory files — keep them as pointers so Claude knows where to look

### Files that STAY as memory (Claude behavioral guidance only)
All `feedback_*` files, `notion-brain-workflow.md`, `repo_layout.md`, `project_roadmap_notion.md`
