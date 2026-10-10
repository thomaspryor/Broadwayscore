---
name: CC tool-budget overflow can hide native tools (Grep/Glob)
description: When too many plugins/MCPs are registered, native tools drop entirely from BOTH eager and deferred lists. ToolSearch returns no match. Trim plugin/MCP footprint to recover.
type: reference
originSessionId: ab9033f9-5f19-4296-ba1a-befd4078c911
archived: true
---
**Symptom:** A session reports "the dedicated tool isn't loadable" and falls back to bash `grep`/`find`. Or `ToolSearch select:Grep,Glob` returns "No matching deferred tools found."

**Cause:** Claude Code has a soft cap on registered tools. When too many plugins, MCP servers, and skills push the count past that cap, native foundational tools (`Grep`, `Glob`) drop out of BOTH the eager AND deferred lists — they become completely uncallable, not just slower to load.

**Verified 2026-04-25** in this user's setup (Broadwayscore + heavy plugins/connectors). Disabling the Vercel plugin alone freed enough to surface Grep/Glob in deferred. Disabling Vercel + Buffer MCP got them deferred-loadable. Eager loading would require disconnecting one of the claude.ai connectors (Notion ~14, Gmail ~10, Calendar ~8, Drive ~7, Granola ~5).

**Diagnostic from inside a session:**
1. Try `ToolSearch select:Grep,Glob`.
2. If "No matching deferred tools found" → tool is fully absent. Need to free budget.
3. If schemas return → tool is deferred-loadable. Acceptable steady state.
4. Eager presence: check the system prompt's tool list at session start (top of prompt).

**Fix order (cheapest → most disruptive):**
1. **`~/.claude/settings.json`** `enabledPlugins`: flip unused plugins to `false`. Highest-impact single edit. (Vercel plugin alone = ~28 skill registrations + 2 MCP tools.)
2. **`~/.claude.json`** project `mcpServers`: stash unused entries to `_disabledMcpServers` (preserves auth tokens for one-line revert).
3. **claude.ai web UI** → Settings → Connectors: disconnect connectors not used in CC sessions. Account-level — affects all Claude UIs, so only do this for connectors you genuinely don't use anywhere.

**Gotcha:** `/exit` followed by re-launch is a *resume*, not a fresh process. Plugin disable changes don't fully apply on resume — eager tool list is fixed at original session start. For a true reload, Cmd+Q the app or close the terminal window, then `claude` again.

**When to accept "deferred":** ToolSearch overhead is one round-trip the first time a session needs the tool. Subagents (Explore, general-purpose, Plan) all have ToolSearch in their toolkit, so they can self-load too. The acute failure mode (tool fully absent) is what matters; deferred is a fine steady state.
