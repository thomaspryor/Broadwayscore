---
name: Always-on Mac Studio for local automation
description: "Prefer launchd + Claude CLI on Mac Studio over RemoteTriggers."
type: feedback
archived: true
---

Tom's Mac Studio is always on. Prefer local automation (launchd + Claude CLI) over RemoteTriggers for any scheduled task that needs:
- Running scripts (`node`, `npm`, `npx`)
- Accessing env vars (API keys for ScrapingBee, Bright Data, OpenAI, etc.)
- Pushing code or triggering deploys
- Full MCP access (Notion, Gmail, Calendar)
- Actually implementing changes (not just read-only investigation)

**Why:** RemoteTriggers run in Anthropic's sandboxed cloud — read-only repo, no env vars, no script execution. The Mac Studio has none of these limitations.

**How to apply:**
- For new scheduled tasks: default to launchd + Claude CLI, not RemoteTrigger
- RemoteTriggers are still fine for lightweight read-only tasks that only need git + Notion (e.g., nightly digest that just reads git log — but even this is better locally)
- Pattern: `~/Library/LaunchAgents/com.bwsc.{name}.plist` → runs a script → script checks if work exists → spawns `claude --prompt "..."` if needed
- RemoteTriggers MIGRATED (2026-03-29): nightly digest + weekly retro now run locally via launchd. Remote triggers disabled.
- **Action Dispatcher** (com.bwsc.action-dispatcher, 5-min poll): polls Notion for cards with Action set, spawns Claude. 4 modes: Investigate, Plan, Review, Start.
- **Nightly Digest** (com.bwsc.nightly-digest, 11 PM): runs send-daily-digest.js
- **Weekly Retro** (com.bwsc.weekly-retro, Sun 10 AM): spawns Claude for week-in-review
- Agent memory files in `scripts/agent-memory/` (gitignored) — self-updating domain knowledge for automated sessions
