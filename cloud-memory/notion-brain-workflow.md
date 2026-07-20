---
name: notion-brain-workflow
description: "Every CC session creates/updates a card. IDs, schema, lifecycle, fallbacks."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b722e13b-a35b-4ed7-8e29-eb895974cc61
  modified: 2026-07-20T03:35:45.779Z
---

## Notion as Project Brain

The BWSC Roadmap in Notion is the single source of truth for all project work — what's planned, in progress, and done.

- **Data source ID:** `collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6`
- **Database ID:** `fa7b3ff2-c073-4097-b54c-0a78e56e06b6`
- **Parent page (BWSC):** `32b637c5-416f-80aa-8001-e84d503ce3c1`
- **Notion = project state** (what to do, what was done). **memory/ = Claude behavior** (how to work, gotchas, rules).

## CLI Tool: `scripts/notion-brain.js`

**Prefer this over Notion MCP tools.** Direct API calls = ~200ms vs ~2-3s MCP round-trip, no disconnection issues, no context window overhead from 14 tool schemas.

```bash
# Create a card (session start)
node scripts/notion-brain.js create "Card title" --status "In progress" --priority "P1 Next" --category Product --tags scoring,scraping

# Update a card (during/end of session)
node scripts/notion-brain.js update <page-id> --status Done --outcome "## Summary" --completed-date 2026-03-31 --key-files "file.js"

# Search (find in-progress or stale cards)
node scripts/notion-brain.js search --status "In progress"

# List (quick overview of priorities)
node scripts/notion-brain.js list --priority "P0 Now,P1 Next" --limit 10

# Get full card details
node scripts/notion-brain.js get <page-id>
```

**Env:** Reads `NOTION_API_KEY` from `.env` automatically. Uses `@notionhq/client` v5 SDK with `dataSources.query()`.

**Fallback:** If the CLI fails (network, auth), fall back to Notion MCP tools. If MCP also fails, buffer updates as text in the Final Report.

**`search --text` only matches Name/Notes, never Tags.** If a script dedupes against existing cards by tag string (e.g. searching `--text "ux-audit"` to find cards tagged `ux-audit`), it silently returns zero results forever — the tag never appears in the title/notes text. Search the literal title text/prefix instead (2026-07-20, ux-walkthrough.mjs dedup was a no-op until fixed).

## Session Lifecycle

### Session Start
1. **Read priorities:** `node scripts/notion-brain.js list --priority "P0 Now,P1 Next" --limit 10`
2. **Check for stale cards:** `node scripts/notion-brain.js search --status "In progress"`. If any are >24h old, flag them.
3. **Create a new card** for this session's work (after user states focus). **Always create new — never reuse by fuzzy match.**
   - `node scripts/notion-brain.js create "Title" --status "In progress" --priority P1 --category Product --tags tag1,tag2`
   - Output the card URL in the session report so it persists in conversation context

### During Session
- If scope changes or new discoveries emerge, update the card's Notes
- If spawning sub-work, create a separate card and link via Notes
- If blocked and switching tasks, update current card to "Paused" with reason in Notes

### Session End (on /wrap-up or natural completion)
1. **Find the card:** `node scripts/notion-brain.js search --status "In progress"`. If exactly 1 → use it. If multiple → list them and ask user which one.
2. **Append Outcome** (prepends to existing by default). Use the MANDATORY template:
   ```
   ## [DATE] — [1-line summary]

   ### What changed
   [Bullet list with file names, function names, data counts. Be specific.]

   ### Why this approach
   [Alternatives considered, constraints that drove the decision.]

   ### Gotchas & watch out
   [What almost broke, what's fragile, what will bite the next session.]

   ### Discovered work
   [New bugs, improvements, tech debt. Each gets its own Notion card.]
   ```
   **Self-check:** Before writing, ask: "Would someone who has never seen this codebase understand what happened and why?" If no, add detail.
3. **Update card:** `node scripts/notion-brain.js update <id> --status Done --outcome "..." --key-files "..." --tags tag1 --completed-date YYYY-MM-DD`
4. **Create new cards** for discovered work (Status="Not started", appropriate Priority).
   **CRITICAL:** Each card MUST be a self-contained handoff — see `feedback_notion_card_context.md`. Include file paths, commands to reproduce, root cause if known, what was tried, and acceptance criteria. Self-check: "Could a fresh session start working in under 2 minutes?"
5. **Fallback:** If CLI fails, try MCP. If both fail, output the full Outcome text to the user.

## Schema Reference

| Field | Type | Format | Purpose |
|---|---|---|---|
| Name | Title | text | Short descriptive name |
| Status | Status | "Not started" / "In progress" / "Paused" / "Done" | Current state |
| Category | Select | "Product" / "Marketing" / "Partnerships" / "Admin" | Area |
| Type | Select | "New Feature" / "Fix" / "Data Quality" / "Market Expansion" | Work type |
| Priority | Select | "P0 Now" / "P1 Next" / "P2 Later" | Urgency |
| Tags | Multi-select | JSON array: `["scoring", "scraping"]` | Subsystems |
| Notes | Text | plain text | Goal, context, blockers, updates |
| Outcome | Text | plain text with markdown | Rich completion summary |
| Key Files | Text | plain text | Commits, PRs, files touched |
| Completed Date | Date | `"date:Completed Date:start": "2026-03-25"` | When finished |

**Available Tags:** scoring, scraping, opening-night, west-end, off-broadway, commercial, email, ios-app, infra, data-quality

## Card Quality Standard
A completed card should be useful to someone who knows nothing about the session:
- What problem was solved
- How it was solved
- Why it was solved that way
- What could go wrong
