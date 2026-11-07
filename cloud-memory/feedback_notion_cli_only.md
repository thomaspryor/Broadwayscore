---
name: Notion CLI only — Notion MCP is hook-blocked
description: "Use node scripts/notion-brain.js. MCP is PreToolUse-blocked."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
---
**Rule:** Never call `mcp__claude_ai_Notion__*` tools. Never `ToolSearch` for tools whose query mentions "notion". Always use `node scripts/notion-brain.js` from the Bash tool.

**Why:**
- The CLI calls the Notion API directly via `@notionhq/client` — ~200ms vs ~2-3s for an MCP roundtrip.
- The Notion MCP exposes ~14 tool schemas. Loading any one of them via ToolSearch burns ~14KB of context for capabilities that `notion-brain.js` already covers.
- The MCP also disconnects often, while the CLI just runs.
- A session on 2026-04-10 wasted context loading Notion MCP schemas via ToolSearch and was caught by the user. The PreToolUse hook was added after that incident to make the rule un-violatable.

**Enforcement (already in place — don't disable):**
1. **PreToolUse hook** `~/.claude/hooks/notion-mcp-block.sh` blocks both:
   - Direct calls to any `mcp__claude_ai_Notion__*` tool (exits 2 with stderr redirect message)
   - `ToolSearch` calls whose `query` matches `notion` or `mcp__claude_ai_Notion` (exits 2 with same redirect)
2. **session-stop.sh** counts both `notion-brain.js` (CLI, preferred) and `notion-update-page|notion-create-page` (MCP, fallback) as valid Notion calls. Previously it only counted MCP, which silently trained sessions to use MCP.
3. **session-start.sh rule #1** explicitly mandates the CLI and warns the MCP is blocked.

**The CLI commands you actually need:**
```bash
# Create
node scripts/notion-brain.js create "Title" --status "In progress" --priority P1 --category Product --tags tag1,tag2
# Update (close)
node scripts/notion-brain.js update <id> --status Done --outcome "$(cat /tmp/outcome.md)" --key-files "..." --completed-date YYYY-MM-DD
# Search
node scripts/notion-brain.js search --status "In progress"
# List by priority
node scripts/notion-brain.js list --priority "P0 Now,P1 Next" --limit 10
# Get full card
node scripts/notion-brain.js get <id>
```

**How to apply:**
- Default to `node scripts/notion-brain.js` for every Notion operation.
- If you find yourself reaching for `mcp__claude_ai_Notion__*`, the hook will block you — read the stderr message and switch to the CLI.
- The ONLY valid reason to fall back to MCP is if `notion-brain.js` is genuinely broken AND you've shown the user the error output. Even then, prefer to fix the CLI first.
- Do not "just check what fields are available" via MCP — read `memory/notion-brain-workflow.md` for the schema instead.
