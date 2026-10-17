---
name: reference_claudeai_connectors_auth_gated
description: "claude.ai connectors (Gmail/GCal/etc) — RESOLVED 2026-07-11; if tools are missing, check the mcp-logs cache and suggest a session restart or /mcp reconnect; do NOT re-diagnose auth/cmux"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 01818bd9-0b9c-4e6d-a366-7b1512af86c3
---

**RESOLVED 2026-07-11.** Fresh sessions (including cmux-launched — cmux runs the standard `~/.local/bin/claude` interactively and only injects hooks) load all claude.ai connector tools (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, Notion, Drive, Granola). Verified: `claude -p "list mcp__ tools"` returned the full set.

**What the 2026-07-07→11 outage actually was:** stale connector/connection state on this machine — sessions were not even ATTEMPTING connector connections (no per-session entries in `~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-claude-ai-Gmail/`). It cleared when the user forced a reconnect via `/mcp` (log shows "Successfully connected… hasTools:true" then "Cleared connection cache for reconnection"). Sessions build their tool catalog once at startup (anthropics/claude-code #59434), so sessions started during an outage never gain the tools until restarted.

**Dead-end diagnoses — do NOT repeat:**
- NOT auth method / subscription: account is healthy Max 20x; `hasAvailableSubscription:false` in ~/.claude.json is a red herring.
- NOT cmux/SDK mode: process tree proves standard interactive CLI.
- Direct `claude mcp add` of Google's MCP URLs CANNOT work: "does not support dynamic client registration" (Anthropic's pre-registered OAuth client only).
- `claude logout/login` cycles don't touch connector state.

**If tools are missing in a future session:** (1) check whether it's session-scoped: `claude -p "list your mcp__ tools"` — if a fresh session HAS them, just restart the affected session; (2) if fresh sessions lack them too, open `/mcp`, select a claude.ai connector, trigger reconnect/authenticate — that cleared it last time; (3) check newest `mcp-logs-claude-ai-Gmail/*.jsonl` for the actual error before theorizing.
